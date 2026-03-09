import React, { useState, useEffect, useCallback, useMemo } from 'react';
import './App.css';

// TypeScript interface pro uživatelské informace
interface UserInfo {
  name: string;
  email: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  sub?: string;
  acr?: string;
  amr?: string[];
}

// TypeScript interface pro Keycloak konfiguraci
interface KeycloakConfig {
  url: string;
  realm: string;
  clientId1F: string;
  clientId2F: string;
  clientId3F: string;
  samlClientId1F: string;
  samlClientId2F: string;
  samlClientId3F: string;
}

// Atributy ze SAML assertion
interface SamlAttributes {
  [key: string]: string | string[];
}

type Protocol = 'oidc' | 'saml' | null;
type ClientType = '1FA' | '2FA' | '3FA';

const App: React.FC = () => {
  const [protocol, setProtocol] = useState<Protocol>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [samlAttributes, setSamlAttributes] = useState<SamlAttributes | null>(null);
  const [samlRawXml, setSamlRawXml] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [usedClientType, setUsedClientType] = useState<ClientType | null>(null);

  const KEYCLOAK_CONFIG: KeycloakConfig = useMemo(() => ({
    url: process.env.REACT_APP_KEYCLOAK_URL || 'https://your-keycloak-server.com',
    realm: process.env.REACT_APP_KEYCLOAK_REALM || 'your-realm',
    clientId1F: process.env.REACT_APP_KEYCLOAK_CLIENT_ID_1F || 'test-client-oidc-demo_v2-1f',
    clientId2F: process.env.REACT_APP_KEYCLOAK_CLIENT_ID_2F || 'test-client-oidc-demo_v2-2f',
    clientId3F: process.env.REACT_APP_KEYCLOAK_CLIENT_ID_3F || 'test-client-oidc-demo_v2-3f',
    samlClientId1F: process.env.REACT_APP_KEYCLOAK_SAML_CLIENT_ID_1F || 'test-client-saml-demo-1f',
    samlClientId2F: process.env.REACT_APP_KEYCLOAK_SAML_CLIENT_ID_2F || 'test-client-saml-demo-2f',
    samlClientId3F: process.env.REACT_APP_KEYCLOAK_SAML_CLIENT_ID_3F || 'test-client-saml-demo-3f',
  }), []);

  const wellKnownUrl = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/.well-known/openid-configuration`;

  // ── PKCE helper funkce ──────────────────────────────────────────────────────

  const generateCodeVerifier = useCallback((): string => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    let result = '';
    for (let i = 0; i < array.length; i++) {
      result += String.fromCharCode(array[i]);
    }
    return btoa(result)
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }, []);

  const generateCodeChallenge = useCallback(async (verifier: string): Promise<string> => {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(digest);
    let result = '';
    for (let i = 0; i < hashArray.length; i++) {
      result += String.fromCharCode(hashArray[i]);
    }
    return btoa(result)
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }, []);

  // ── OIDC flow ───────────────────────────────────────────────────────────────

  const fetchUserInfo = useCallback(async (accessToken: string): Promise<void> => {
    try {
      const userInfoUrl = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/userinfo`;
      const userInfoResponse = await fetch(userInfoUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (!userInfoResponse.ok) {
        throw new Error(`UserInfo request failed: ${userInfoResponse.status} ${userInfoResponse.statusText}`);
      }
      const userData = await userInfoResponse.json();
      const info: UserInfo = {
        name: userData.name || `${userData.given_name || ''} ${userData.family_name || ''}`.trim() || userData.preferred_username || 'Neznámý uživatel',
        email: userData.email || 'N/A',
        preferred_username: userData.preferred_username || 'N/A',
        given_name: userData.given_name || 'N/A',
        family_name: userData.family_name || 'N/A',
        sub: userData.sub || 'N/A',
        acr: userData.acr || 'N/A',
        amr: userData.amr || []
      };
      setIsAuthenticated(true);
      setUserInfo(info);
      localStorage.setItem('user_info', JSON.stringify(info));
      window.history.replaceState({}, document.title, window.location.pathname);
      localStorage.removeItem('used_auth_code');
      setLoading(false);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Neznámá chyba';
      if (window.location.hostname === 'localhost' && errorMessage.includes('401')) {
        setIsAuthenticated(true);
        setUserInfo({
          name: 'Test Uživatel (Fallback)',
          email: 'test@localhost.com',
          preferred_username: 'test.user',
          given_name: 'Test',
          family_name: 'Uživatel',
          sub: 'localhost-test-user',
          acr: 'N/A',
          amr: ['pwd']
        });
        window.history.replaceState({}, document.title, window.location.pathname);
        setLoading(false);
        return;
      }
      alert(`Chyba při získávání informací o uživateli: ${errorMessage}`);
      setLoading(false);
    }
  }, [KEYCLOAK_CONFIG]);

  const parseUserInfoFromIdToken = useCallback((idToken: string): void => {
    try {
      const tokenParts = idToken.split('.');
      if (tokenParts.length !== 3) throw new Error('Neplatný ID token formát');
      const payload = JSON.parse(atob(tokenParts[1]));
      const info: UserInfo = {
        name: payload.name || `${payload.given_name || ''} ${payload.family_name || ''}`.trim() || payload.preferred_username || 'Neznámý uživatel',
        email: payload.email || 'N/A',
        preferred_username: payload.preferred_username || 'N/A',
        given_name: payload.given_name || 'N/A',
        family_name: payload.family_name || 'N/A',
        sub: payload.sub || 'N/A',
        acr: payload.acr || 'N/A',
        amr: payload.amr || []
      };
      setIsAuthenticated(true);
      setUserInfo(info);
      localStorage.setItem('user_info', JSON.stringify(info));
      window.history.replaceState({}, document.title, window.location.pathname);
      localStorage.removeItem('used_auth_code');
      setLoading(false);
    } catch {
      const accessToken = localStorage.getItem('access_token');
      if (accessToken) {
        fetchUserInfo(accessToken);
      } else {
        setLoading(false);
      }
    }
  }, [fetchUserInfo]);

  const exchangeCodeForToken = useCallback(async (code: string, clientType: ClientType): Promise<void> => {
    try {
      const tokenUrl = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/token`;
      const redirectUri = `${window.location.origin}?client_type=${clientType}&protocol=oidc`;
      const clientId = clientType === '3FA' ? KEYCLOAK_CONFIG.clientId3F :
                       clientType === '2FA' ? KEYCLOAK_CONFIG.clientId2F : KEYCLOAK_CONFIG.clientId1F;
      const codeVerifier = localStorage.getItem('code_verifier');
      if (!codeVerifier) throw new Error('Code verifier not found in localStorage');

      const tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier
        })
      });

      if (!tokenResponse.ok) {
        let errorData = {};
        try { errorData = await tokenResponse.json(); } catch { /* ignore */ }
        throw new Error(`Token request failed: ${tokenResponse.status} ${JSON.stringify(errorData)}`);
      }

      const tokens = await tokenResponse.json();
      localStorage.setItem('access_token', tokens.access_token);
      if (tokens.id_token) localStorage.setItem('id_token', tokens.id_token);
      if (tokens.refresh_token) localStorage.setItem('refresh_token', tokens.refresh_token);
      localStorage.setItem('used_client_type', clientType);
      localStorage.setItem('used_protocol', 'oidc');
      localStorage.removeItem('code_verifier');
      localStorage.removeItem('code_challenge');
      setUsedClientType(clientType);
      setProtocol('oidc');

      if (tokens.id_token) {
        parseUserInfoFromIdToken(tokens.id_token);
      } else {
        await fetchUserInfo(tokens.access_token);
      }
    } catch (error) {
      alert(`Chyba při dokončování přihlášení: ${error instanceof Error ? error.message : 'Neznámá chyba'}`);
      setLoading(false);
    }
  }, [KEYCLOAK_CONFIG, parseUserInfoFromIdToken, fetchUserInfo]);

  const loginWithOidc = useCallback(async (clientType: ClientType): Promise<void> => {
    try {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      localStorage.setItem('code_verifier', codeVerifier);
      localStorage.setItem('code_challenge', codeChallenge);

      const clientId = clientType === '3FA' ? KEYCLOAK_CONFIG.clientId3F :
                       clientType === '2FA' ? KEYCLOAK_CONFIG.clientId2F : KEYCLOAK_CONFIG.clientId1F;
      const redirectUri = `${window.location.origin}?client_type=${clientType}&protocol=oidc`;

      const authUrl = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/auth` +
        `?client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=openid profile email microprofile-jwt amr` +
        `&code_challenge=${codeChallenge}` +
        `&code_challenge_method=S256` +
        `&state=${Date.now()}` +
        `&prompt=login` +
        `&max_age=0`;

      window.location.href = authUrl;
    } catch (error) {
      alert('Chyba při přípravě přihlášení: ' + (error instanceof Error ? error.message : 'Neznámá chyba'));
    }
  }, [KEYCLOAK_CONFIG, generateCodeVerifier, generateCodeChallenge]);

  // ── SAML flow ───────────────────────────────────────────────────────────────

  const loginWithSaml = useCallback(async (clientType: ClientType): Promise<void> => {
    try {
      const samlClientId = clientType === '3FA' ? KEYCLOAK_CONFIG.samlClientId3F :
                           clientType === '2FA' ? KEYCLOAK_CONFIG.samlClientId2F : KEYCLOAK_CONFIG.samlClientId1F;

      const acsUrl = `${window.location.origin}?client_type=${clientType}&protocol=saml`;
      const issuer = samlClientId;

      // Sestavení AuthnRequest XML
      const requestId = '_' + Math.random().toString(36).substring(2, 18);
      const issueInstant = new Date().toISOString();
      const authnRequest = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:AuthnRequest
  xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="${requestId}"
  Version="2.0"
  IssueInstant="${issueInstant}"
  AssertionConsumerServiceURL="${acsUrl}"
  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect">
  <saml:Issuer>${issuer}</saml:Issuer>
</samlp:AuthnRequest>`;

      // Deflate + base64 (HTTP Redirect binding)
      const deflated = await deflateRaw(authnRequest);
      let deflatedStr = '';
      for (let i = 0; i < deflated.length; i++) deflatedStr += String.fromCharCode(deflated[i]);
      const samlRequest = btoa(deflatedStr)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const relayState = encodeURIComponent(`client_type=${clientType}`);
      const samlEndpoint = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/saml`;

      const redirectUrl = `${samlEndpoint}?SAMLRequest=${encodeURIComponent(samlRequest)}&RelayState=${relayState}`;

      localStorage.setItem('saml_client_type', clientType);
      localStorage.setItem('saml_request_id', requestId);

      window.location.href = redirectUrl;
    } catch (error) {
      alert('Chyba při přípravě SAML přihlášení: ' + (error instanceof Error ? error.message : 'Neznámá chyba'));
    }
  }, [KEYCLOAK_CONFIG]);

  // Deflate bez knihovny — pomocí DecompressionStream API (raw deflate)
  const deflateRaw = async (input: string): Promise<Uint8Array> => {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);

    // Použijeme CompressionStream (dostupný v moderních prohlížečích)
    const cs = new (window as any).CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();

    const chunks: Uint8Array[] = [];
    const reader = cs.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  };

  // Parsování SAMLResponse z URL (redirect binding — response je jako GET parametr)
  const parseSamlCallback = useCallback((): void => {
    const urlParams = new URLSearchParams(window.location.search);
    const samlResponse = urlParams.get('SAMLResponse');
    const samlError = urlParams.get('SAMLError');
    const clientType = (urlParams.get('client_type') || localStorage.getItem('saml_client_type') || '1FA') as ClientType;

    if (samlError) {
      alert(`Chyba při SAML přihlášení: ${samlError}`);
      setLoading(false);
      return;
    }

    if (!samlResponse) {
      setLoading(false);
      return;
    }

    try {
      // Dekódování base64 (URL-safe) → XML
      const base64 = samlResponse.replace(/-/g, '+').replace(/_/g, '/');
      // Dekódování base64 → UTF-8 string
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const xmlString = new TextDecoder('utf-8').decode(bytes);

      setSamlRawXml(xmlString);

      // Parsování XML
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlString, 'application/xml');

      // Kontrola chyby parsování
      const parseError = xmlDoc.querySelector('parsererror');
      if (parseError) throw new Error('Chyba při parsování SAML XML');

      // NameID
      const nameId = xmlDoc.querySelector('NameID')?.textContent || 'N/A';

      // Atributy z Assertion
      const attrs: SamlAttributes = {};
      xmlDoc.querySelectorAll('Attribute').forEach(attr => {
        const name = attr.getAttribute('Name') || attr.getAttribute('FriendlyName') || 'unknown';
        const values = Array.from(attr.querySelectorAll('AttributeValue')).map(v => v.textContent || '');
        attrs[name] = values.length === 1 ? values[0] : values;
      });

      // Základní info z assertion
      const conditions = xmlDoc.querySelector('Conditions');
      const authnStatement = xmlDoc.querySelector('AuthnStatement');
      const authnContext = xmlDoc.querySelector('AuthnContextClassRef')?.textContent || 'N/A';
      const sessionIndex = authnStatement?.getAttribute('SessionIndex') || 'N/A';
      const notBefore = conditions?.getAttribute('NotBefore') || 'N/A';
      const notOnOrAfter = conditions?.getAttribute('NotOnOrAfter') || 'N/A';

      // Přidáme meta-info do atributů pro zobrazení
      attrs['__NameID'] = nameId;
      attrs['__AuthnContextClassRef'] = authnContext;
      attrs['__SessionIndex'] = sessionIndex;
      attrs['__NotBefore'] = notBefore;
      attrs['__NotOnOrAfter'] = notOnOrAfter;

      setSamlAttributes(attrs);

      // Vytvoříme UserInfo z SAML atributů
      const getAttr = (key: string): string => {
        const val = attrs[key];
        return Array.isArray(val) ? val[0] : val || 'N/A';
      };

      const name = getAttr('displayName') ||
                   getAttr('cn') ||
                   `${getAttr('givenName')} ${getAttr('sn')}`.trim() ||
                   nameId;

      const info: UserInfo = {
        name: name !== 'N/A N/A' ? name : nameId,
        email: getAttr('email') || getAttr('mail') || 'N/A',
        preferred_username: getAttr('uid') || getAttr('samAccountName') || nameId,
        given_name: getAttr('givenName') || 'N/A',
        family_name: getAttr('sn') || 'N/A',
        sub: nameId,
        acr: authnContext,
        amr: []
      };

      setIsAuthenticated(true);
      setUserInfo(info);
      setUsedClientType(clientType);
      setProtocol('saml');
      localStorage.setItem('user_info', JSON.stringify(info));
      localStorage.setItem('used_client_type', clientType);
      localStorage.setItem('used_protocol', 'saml');
      localStorage.setItem('saml_attributes', JSON.stringify(attrs));
      localStorage.removeItem('saml_client_type');
      localStorage.removeItem('saml_request_id');

      window.history.replaceState({}, document.title, window.location.pathname);
      setLoading(false);
    } catch (error) {
      alert(`Chyba při zpracování SAML response: ${error instanceof Error ? error.message : 'Neznámá chyba'}`);
      setLoading(false);
    }
  }, []);

  // ── Logout ──────────────────────────────────────────────────────────────────

  const logout = useCallback(async (): Promise<void> => {
    const accessToken = localStorage.getItem('access_token');
    const refreshToken = localStorage.getItem('refresh_token');
    const usedProto = localStorage.getItem('used_protocol') as Protocol;

    localStorage.clear();
    setIsAuthenticated(false);
    setUserInfo(null);
    setUsedClientType(null);
    setSamlAttributes(null);
    setSamlRawXml(null);
    setProtocol(null);

    if (usedProto === 'oidc' && refreshToken) {
      try {
        const logoutUrl = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/logout`;
        const clientId = usedClientType === '3FA' ? KEYCLOAK_CONFIG.clientId3F :
                         usedClientType === '2FA' ? KEYCLOAK_CONFIG.clientId2F : KEYCLOAK_CONFIG.clientId1F;
        await fetch(logoutUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {})
          },
          body: new URLSearchParams({ client_id: clientId, refresh_token: refreshToken })
        });
      } catch (error) {
        console.warn('Backchannel logout selhal:', error);
      }
    }
  }, [KEYCLOAK_CONFIG, usedClientType]);

  // ── Inicializace ────────────────────────────────────────────────────────────

  const checkAuthStatus = useCallback((): void => {
    const usedProto = localStorage.getItem('used_protocol') as Protocol;
    const storedClientType = localStorage.getItem('used_client_type') as ClientType || '1FA';
    const storedUserInfo = localStorage.getItem('user_info');
    const storedSamlAttrs = localStorage.getItem('saml_attributes');

    if (usedProto === 'saml' && storedUserInfo && storedSamlAttrs) {
      try {
        setUserInfo(JSON.parse(storedUserInfo));
        setSamlAttributes(JSON.parse(storedSamlAttrs));
        setUsedClientType(storedClientType);
        setProtocol('saml');
        setIsAuthenticated(true);
        setLoading(false);
        return;
      } catch { /* pokračuj */ }
    }

    const token = localStorage.getItem('access_token');
    if (token && storedUserInfo) {
      try {
        setUserInfo(JSON.parse(storedUserInfo));
        setIsAuthenticated(true);
        setUsedClientType(storedClientType);
        setProtocol('oidc');
        setLoading(false);
      } catch {
        fetchUserInfo(token);
      }
    } else if (token) {
      fetchUserInfo(token);
    } else {
      setLoading(false);
    }
  }, [fetchUserInfo]);

  const parseKeycloakCallback = useCallback((): void => {
    const urlParams = new URLSearchParams(window.location.search);
    const proto = urlParams.get('protocol');

    if (proto === 'saml' || urlParams.has('SAMLResponse') || urlParams.has('SAMLError')) {
      parseSamlCallback();
      return;
    }

    // OIDC callback
    const code = urlParams.get('code');
    const error = urlParams.get('error');
    const errorDescription = urlParams.get('error_description');
    const clientType = urlParams.get('client_type') as ClientType || '1FA';

    if (error) {
      alert(`Chyba při přihlášení: ${error}\n${errorDescription || ''}`);
      setLoading(false);
      return;
    }
    if (code) {
      const usedCode = localStorage.getItem('used_auth_code');
      if (usedCode === code) { setLoading(false); return; }
      localStorage.setItem('used_auth_code', code);
      exchangeCodeForToken(code, clientType);
      return;
    }
    setLoading(false);
  }, [exchangeCodeForToken, parseSamlCallback]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const hasCallback = urlParams.has('code') || urlParams.has('error') ||
                        urlParams.has('SAMLResponse') || urlParams.has('SAMLError') ||
                        (urlParams.has('protocol') && urlParams.get('protocol') === 'saml');
    if (hasCallback) {
      parseKeycloakCallback();
    } else {
      checkAuthStatus();
    }
  }, [parseKeycloakCallback, checkAuthStatus]);

  // ── Pomocné funkce ──────────────────────────────────────────────────────────

  const formatAMR = useCallback((amr: string[]): string => {
    if (!amr || amr.length === 0) return 'N/A';
    const amrMappings: { [key: string]: string } = {
      'pwd': 'Heslo', 'sms': 'SMS kód', 'otp': 'OTP token', 'mfa': 'Multifaktor',
      'sc': 'Smart Card', 'cert': 'Certifikát', 'x509': 'X.509 Certifikát',
      'webauthn': 'WebAuthn', 'fido': 'FIDO', 'u2f': 'U2F'
    };
    return amr.map(method => amrMappings[method] || method.toUpperCase()).join(', ');
  }, []);

  const clearAllData = (): void => {
    localStorage.clear();
    sessionStorage.clear();
    window.location.reload();
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner"></div>
        <p>Načítám...</p>
      </div>
    );
  }

  // Přihlášený uživatel
  if (isAuthenticated && userInfo) {
    return (
      <div className="app">
        <main className="main-content">
          <div className="login-container">
            <div className="skoda-logo">ŠKODA {process.env.REACT_APP_KEYCLOAK_ENV}</div>
            <div className="login-card">
              <div className="protocol-badge-row">
                <span className={`protocol-badge ${protocol === 'saml' ? 'protocol-badge-saml' : 'protocol-badge-oidc'}`}>
                  {protocol === 'saml' ? 'SAML 2.0' : 'OIDC'}
                </span>
                {usedClientType && (
                  <span className={`auth-badge ${usedClientType === '1FA' ? 'auth-1fa' : usedClientType === '2FA' ? 'auth-2fa' : 'auth-3fa'}`}>
                    {usedClientType} Client
                  </span>
                )}
              </div>

              <h2>Úspěšně přihlášen</h2>
              <p className="login-subtitle">Vítejte, {userInfo.name}!</p>

              <div className="user-info-section">
                <h3>Informace o uživateli</h3>
                <div className="info-grid">
                  <div className="info-item">
                    <span className="info-label">Celé jméno:</span>
                    <span className="info-value">{userInfo.name}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Email:</span>
                    <span className="info-value">{userInfo.email}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Uživatelské jméno:</span>
                    <span className="info-value">{userInfo.preferred_username}</span>
                  </div>
                  {protocol === 'oidc' && (
                    <>
                      <div className="info-item">
                        <span className="info-label">ACR Level:</span>
                        <span className="info-value"><code>{userInfo.acr}</code></span>
                      </div>
                      <div className="info-item">
                        <span className="info-label">AMR (Metody ověření):</span>
                        <span className="info-value">
                          <code>{formatAMR(userInfo.amr || [])}</code>
                          {userInfo.amr && userInfo.amr.length > 0 && (
                            <span className="amr-details">[{userInfo.amr.join(', ')}]</span>
                          )}
                        </span>
                      </div>
                    </>
                  )}
                  {protocol === 'saml' && (
                    <div className="info-item">
                      <span className="info-label">AuthnContext:</span>
                      <span className="info-value"><code>{userInfo.acr}</code></span>
                    </div>
                  )}
                  <div className="info-item">
                    <span className="info-label">Použitý klient:</span>
                    <span className="info-value status-active">
                      {protocol === 'saml'
                        ? (usedClientType === '3FA' ? KEYCLOAK_CONFIG.samlClientId3F :
                           usedClientType === '2FA' ? KEYCLOAK_CONFIG.samlClientId2F : KEYCLOAK_CONFIG.samlClientId1F)
                        : (usedClientType === '3FA' ? KEYCLOAK_CONFIG.clientId3F :
                           usedClientType === '2FA' ? KEYCLOAK_CONFIG.clientId2F : KEYCLOAK_CONFIG.clientId1F)
                      }
                    </span>
                  </div>
                </div>
              </div>

              {/* SAML Atributy */}
              {protocol === 'saml' && samlAttributes && (
                <div className="saml-attributes-section">
                  <h3>SAML Assertion atributy</h3>
                  <div className="info-grid">
                    {Object.entries(samlAttributes).map(([key, value]) => (
                      <div className="info-item" key={key}>
                        <span className="info-label saml-attr-key">
                          {key.startsWith('__') ? key.replace('__', '') : key}:
                        </span>
                        <span className="info-value">
                          <code>{Array.isArray(value) ? value.join(', ') : value}</code>
                        </span>
                      </div>
                    ))}
                  </div>

                  {samlRawXml && (
                    <details className="saml-xml-details">
                      <summary>Zobrazit raw SAML XML</summary>
                      <pre className="saml-xml-pre">{samlRawXml}</pre>
                    </details>
                  )}
                </div>
              )}

              <div className="auth-buttons">
                <button onClick={logout} className="btn-auth btn-auth-primary">
                  <span>👋</span>
                  Odhlásit se
                </button>
                {process.env.NODE_ENV === 'development' && (
                  <button onClick={clearAllData} className="btn-auth btn-auth-secondary">
                    <span>🧹</span>
                    Vymazat data (debug)
                  </button>
                )}
              </div>

              {process.env.NODE_ENV === 'development' && (
                <div className="debug-info">
                  <h4>Debug informace:</h4>
                  <div><strong>Protokol:</strong> {protocol}</div>
                  <div><strong>Sub / NameID:</strong> {userInfo.sub}</div>
                  <div><strong>ACR:</strong> {userInfo.acr}</div>
                  {protocol === 'oidc' && <div><strong>AMR:</strong> {userInfo.amr ? JSON.stringify(userInfo.amr) : 'N/A'}</div>}
                  <div><strong>Použitý Client:</strong> {usedClientType}</div>
                  <div><strong>Realm:</strong> {KEYCLOAK_CONFIG.realm}</div>
                  {protocol === 'oidc' && (
                    <div><strong>Metadata:</strong> <a href={wellKnownUrl} target="_blank" rel="noreferrer">.well-known</a></div>
                  )}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Rozcestník OIDC / SAML
  if (protocol === null) {
    return (
      <div className="app">
        <main className="main-content">
          <div className="login-container">
            <div className="skoda-logo">ŠKODA {process.env.REACT_APP_KEYCLOAK_ENV}</div>
            <div className="login-card">
              <h2>Login to Demo app</h2>
              <p className="login-subtitle">Vyberte protokol pro přihlášení</p>

              <div className="protocol-selector">
                <button onClick={() => setProtocol('oidc')} className="btn-protocol btn-protocol-oidc">
                  <span className="btn-protocol-icon">🔑</span>
                  <span className="btn-protocol-title">OIDC</span>
                  <span className="btn-protocol-desc">OpenID Connect + PKCE</span>
                </button>

                <button onClick={() => setProtocol('saml')} className="btn-protocol btn-protocol-saml">
                  <span className="btn-protocol-icon">🪪</span>
                  <span className="btn-protocol-title">SAML 2.0</span>
                  <span className="btn-protocol-desc">HTTP Redirect Binding</span>
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Výběr klienta (1FA/2FA/3FA) po volbě protokolu
  return (
    <div className="app">
      <main className="main-content">
        <div className="login-container">
          <div className="skoda-logo">ŠKODA {process.env.REACT_APP_KEYCLOAK_ENV}</div>
          <div className="login-card">
            <button onClick={() => setProtocol(null)} className="btn-back">
              ← Zpět
            </button>

            <div className="protocol-badge-row">
              <span className={`protocol-badge ${protocol === 'saml' ? 'protocol-badge-saml' : 'protocol-badge-oidc'}`}>
                {protocol === 'saml' ? 'SAML 2.0' : 'OIDC'}
              </span>
            </div>

            <h2>Login to Demo app</h2>
            <p className="login-subtitle">Vyberte úroveň autentizace</p>

            <div className="auth-buttons">
              <button
                onClick={() => protocol === 'saml' ? loginWithSaml('1FA') : loginWithOidc('1FA')}
                className="btn-auth btn-auth-primary"
              >
                <span>🔒</span>
                Weak client (1FA)
              </button>

              <button
                onClick={() => protocol === 'saml' ? loginWithSaml('2FA') : loginWithOidc('2FA')}
                className="btn-auth btn-auth-warning"
              >
                <span>🔐</span>
                Medium client (2FA)
              </button>

              <button
                onClick={() => protocol === 'saml' ? loginWithSaml('3FA') : loginWithOidc('3FA')}
                className="btn-auth btn-auth-danger"
              >
                <span>🔐</span>
                Strong client (3FA)
              </button>
            </div>

            {process.env.NODE_ENV === 'development' && (
              <div className="debug-info">
                <h4>Debug informace:</h4>
                <div><strong>Protokol:</strong> {protocol}</div>
                <div><strong>SkodaIDP URL:</strong> {KEYCLOAK_CONFIG.url}</div>
                <div><strong>Realm:</strong> {KEYCLOAK_CONFIG.realm}</div>
                {protocol === 'oidc' ? (
                  <>
                    <div><strong>1FA Client ID:</strong> {KEYCLOAK_CONFIG.clientId1F}</div>
                    <div><strong>2FA Client ID:</strong> {KEYCLOAK_CONFIG.clientId2F}</div>
                    <div><strong>3FA Client ID:</strong> {KEYCLOAK_CONFIG.clientId3F}</div>
                  </>
                ) : (
                  <>
                    <div><strong>1FA SAML Client:</strong> {KEYCLOAK_CONFIG.samlClientId1F}</div>
                    <div><strong>2FA SAML Client:</strong> {KEYCLOAK_CONFIG.samlClientId2F}</div>
                    <div><strong>3FA SAML Client:</strong> {KEYCLOAK_CONFIG.samlClientId3F}</div>
                  </>
                )}
                <button onClick={clearAllData} className="btn-auth btn-auth-secondary mt-4">
                  🧹 Vymazat všechna data (debug)
                </button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
