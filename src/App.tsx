import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { deflateRaw, inflateRaw } from 'pako';
import {
  SkodaThemeProvider,
  Logo,
  PageLayout,
  Header,
  HeaderLogo,
  Footer,
  Banner,
} from '@skodaflow/web-library';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import LogoutIcon from '@mui/icons-material/Logout';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import BadgeIcon from '@mui/icons-material/Badge';
import ShieldIcon from '@mui/icons-material/Shield';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import LockIcon from '@mui/icons-material/Lock';
import './App.css';

// ── Typy ──────────────────────────────────────────────────────────────────────

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

interface SamlAttributes {
  [key: string]: string | string[];
}

interface EnvConfig {
  label: string;
  url: string;
  realm: string;
  oidcClient1F: string;
  oidcClient2F: string;
  oidcClient3F: string;
  samlClient1F: string;
  samlClient2F: string;
  samlClient3F: string;
}

interface AppConfig {
  environments: { [key: string]: EnvConfig };
}

type Protocol = 'oidc' | 'saml' | null;
type ClientType = '1FA' | '2FA' | '3FA';
type Stage = 'env' | 'protocol' | 'clientType';

// ── Konstanty ─────────────────────────────────────────────────────────────────

const SKODA_GREEN = '#78faae';
const STORAGE_ENV_KEY = 'sip_demo_env';

// ── Helpers pro výběr clientId podle typu ────────────────────────────────────

const oidcClientIdFor = (env: EnvConfig, t: ClientType): string =>
  t === '3FA' ? env.oidcClient3F : t === '2FA' ? env.oidcClient2F : env.oidcClient1F;

const samlClientIdFor = (env: EnvConfig, t: ClientType): string =>
  t === '3FA' ? env.samlClient3F : t === '2FA' ? env.samlClient2F : env.samlClient1F;

// ──────────────────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [selectedEnv, setSelectedEnv] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<Protocol>(null);
  const [usedClientType, setUsedClientType] = useState<ClientType | null>(null);

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [samlAttributes, setSamlAttributes] = useState<SamlAttributes | null>(null);
  const [samlRawXml, setSamlRawXml] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Aktivní env config
  const envConfig: EnvConfig | null = useMemo(() => {
    if (!config || !selectedEnv) return null;
    return config.environments[selectedEnv] ?? null;
  }, [config, selectedEnv]);

  // Stage: kde v rozcestníku se uživatel nachází (před přihlášením)
  const stage: Stage = !selectedEnv ? 'env' : !protocol ? 'protocol' : 'clientType';

  // ── Načtení runtime config ────────────────────────────────────────────────

  useEffect(() => {
    fetch('/config.json', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`Nelze načíst config.json (${res.status})`);
        return res.json();
      })
      .then((cfg: AppConfig) => {
        setConfig(cfg);
        // Pokus o obnovení dříve zvoleného env
        const stored = localStorage.getItem(STORAGE_ENV_KEY);
        if (stored && cfg.environments[stored]) {
          setSelectedEnv(stored);
        }
      })
      .catch((err) => {
        setConfigError(err instanceof Error ? err.message : 'Neznámá chyba');
      });
  }, []);

  // ── PKCE helpers ──────────────────────────────────────────────────────────

  const generateCodeVerifier = useCallback((): string => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    let result = '';
    for (let i = 0; i < array.length; i++) result += String.fromCharCode(array[i]);
    return btoa(result).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }, []);

  const generateCodeChallenge = useCallback(async (verifier: string): Promise<string> => {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(digest);
    let result = '';
    for (let i = 0; i < hashArray.length; i++) result += String.fromCharCode(hashArray[i]);
    return btoa(result).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }, []);

  // ── OIDC flow ─────────────────────────────────────────────────────────────

  const fetchUserInfo = useCallback(async (env: EnvConfig, accessToken: string): Promise<void> => {
    try {
      const userInfoUrl = `${env.url}/realms/${env.realm}/protocol/openid-connect/userinfo`;
      const res = await fetch(userInfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`UserInfo request failed: ${res.status} ${res.statusText}`);
      const userData = await res.json();
      const info: UserInfo = {
        name: userData.name || `${userData.given_name || ''} ${userData.family_name || ''}`.trim() || userData.preferred_username || 'Neznámý uživatel',
        email: userData.email || 'N/A',
        preferred_username: userData.preferred_username || 'N/A',
        given_name: userData.given_name || 'N/A',
        family_name: userData.family_name || 'N/A',
        sub: userData.sub || 'N/A',
        acr: userData.acr || 'N/A',
        amr: userData.amr || [],
      };
      setIsAuthenticated(true);
      setUserInfo(info);
      localStorage.setItem('user_info', JSON.stringify(info));
      window.history.replaceState({}, document.title, window.location.pathname);
      localStorage.removeItem('used_auth_code');
      setLoading(false);
    } catch (error) {
      setErrorMsg(`Chyba při získávání informací o uživateli: ${error instanceof Error ? error.message : 'Neznámá chyba'}`);
      setLoading(false);
    }
  }, []);

  const parseUserInfoFromIdToken = useCallback((env: EnvConfig, idToken: string): void => {
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
        amr: payload.amr || [],
      };
      setIsAuthenticated(true);
      setUserInfo(info);
      localStorage.setItem('user_info', JSON.stringify(info));
      window.history.replaceState({}, document.title, window.location.pathname);
      localStorage.removeItem('used_auth_code');
      setLoading(false);
    } catch {
      const accessToken = localStorage.getItem('access_token');
      if (accessToken) fetchUserInfo(env, accessToken);
      else setLoading(false);
    }
  }, [fetchUserInfo]);

  const exchangeCodeForToken = useCallback(async (env: EnvConfig, code: string, clientType: ClientType): Promise<void> => {
    try {
      const tokenUrl = `${env.url}/realms/${env.realm}/protocol/openid-connect/token`;
      const redirectUri = `${window.location.origin}?client_type=${clientType}&protocol=oidc`;
      const clientId = oidcClientIdFor(env, clientType);
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
          code_verifier: codeVerifier,
        }),
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

      if (tokens.id_token) parseUserInfoFromIdToken(env, tokens.id_token);
      else await fetchUserInfo(env, tokens.access_token);
    } catch (error) {
      setErrorMsg(`Chyba při dokončování přihlášení: ${error instanceof Error ? error.message : 'Neznámá chyba'}`);
      setLoading(false);
    }
  }, [parseUserInfoFromIdToken, fetchUserInfo]);

  const loginWithOidc = useCallback(async (clientType: ClientType): Promise<void> => {
    if (!envConfig) return;
    try {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      localStorage.setItem('code_verifier', codeVerifier);
      localStorage.setItem('code_challenge', codeChallenge);

      const clientId = oidcClientIdFor(envConfig, clientType);
      const redirectUri = `${window.location.origin}?client_type=${clientType}&protocol=oidc`;

      const authUrl = `${envConfig.url}/realms/${envConfig.realm}/protocol/openid-connect/auth` +
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
      setErrorMsg('Chyba při přípravě přihlášení: ' + (error instanceof Error ? error.message : 'Neznámá chyba'));
    }
  }, [envConfig, generateCodeVerifier, generateCodeChallenge]);

  // ── SAML flow ─────────────────────────────────────────────────────────────

  const loginWithSaml = useCallback(async (clientType: ClientType): Promise<void> => {
    if (!envConfig) return;
    try {
      const samlClientId = samlClientIdFor(envConfig, clientType);
      const acsUrl = `${window.location.origin}?client_type=${clientType}&amp;protocol=saml`;
      const requestId = '_' + Math.random().toString(36).substring(2, 18);
      const issueInstant = new Date().toISOString();
      const authnRequest = `<?xml version="1.0" encoding="UTF-8"?><samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${requestId}" Version="2.0" IssueInstant="${issueInstant}" AssertionConsumerServiceURL="${acsUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"><saml:Issuer>${samlClientId}</saml:Issuer></samlp:AuthnRequest>`;

      const deflated = deflateRaw(authnRequest);
      let deflatedStr = '';
      for (let i = 0; i < deflated.length; i++) deflatedStr += String.fromCharCode(deflated[i]);
      const samlRequest = encodeURIComponent(btoa(deflatedStr));

      const relayState = encodeURIComponent(`client_type=${clientType}`);
      const samlEndpoint = `${envConfig.url}/realms/${envConfig.realm}/protocol/saml`;
      const redirectUrl = `${samlEndpoint}?SAMLRequest=${samlRequest}&RelayState=${relayState}`;

      localStorage.setItem('saml_client_type', clientType);
      localStorage.setItem('saml_request_id', requestId);

      window.location.href = redirectUrl;
    } catch (error) {
      setErrorMsg('Chyba při přípravě SAML přihlášení: ' + (error instanceof Error ? error.message : 'Neznámá chyba'));
    }
  }, [envConfig]);

  const parseSamlCallback = useCallback((): void => {
    const urlParams = new URLSearchParams(window.location.search);
    const samlResponse = urlParams.get('SAMLResponse');
    const samlError = urlParams.get('SAMLError');
    const clientType = (urlParams.get('client_type') || localStorage.getItem('saml_client_type') || '1FA') as ClientType;

    if (samlError) {
      setErrorMsg(`Chyba při SAML přihlášení: ${samlError}`);
      setLoading(false);
      return;
    }
    if (!samlResponse) { setLoading(false); return; }

    try {
      const binaryStr = atob(samlResponse);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      let xmlString: string;
      try { xmlString = new TextDecoder('utf-8').decode(inflateRaw(bytes)); }
      catch { xmlString = new TextDecoder('utf-8').decode(bytes); }

      setSamlRawXml(xmlString);

      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlString, 'application/xml');
      const parseError = xmlDoc.querySelector('parsererror');
      if (parseError) throw new Error('Chyba při parsování SAML XML');

      const nameId = xmlDoc.querySelector('NameID')?.textContent || 'N/A';

      const attrs: SamlAttributes = {};
      xmlDoc.querySelectorAll('Attribute').forEach((attr) => {
        const name = attr.getAttribute('Name') || attr.getAttribute('FriendlyName') || 'unknown';
        const values = Array.from(attr.querySelectorAll('AttributeValue')).map((v) => v.textContent || '');
        if (attrs[name]) {
          const existing = Array.isArray(attrs[name]) ? (attrs[name] as string[]) : [attrs[name] as string];
          attrs[name] = [...existing, ...values];
        } else {
          attrs[name] = values.length === 1 ? values[0] : values;
        }
      });

      const conditions = xmlDoc.querySelector('Conditions');
      const authnStatement = xmlDoc.querySelector('AuthnStatement');
      const authnContext = xmlDoc.querySelector('AuthnContextClassRef')?.textContent?.trim() || 'N/A';
      const sessionIndex = authnStatement?.getAttribute('SessionIndex') || 'N/A';
      const notBefore = conditions?.getAttribute('NotBefore') || 'N/A';
      const notOnOrAfter = conditions?.getAttribute('NotOnOrAfter') || 'N/A';

      attrs['__NameID'] = nameId;
      attrs['__AuthnContext'] = authnContext;
      attrs['__SessionIndex'] = sessionIndex;
      attrs['__NotBefore'] = notBefore;
      attrs['__NotOnOrAfter'] = notOnOrAfter;

      setSamlAttributes(attrs);

      const getAttr = (key: string): string => {
        const val = attrs[key];
        return Array.isArray(val) ? val[0] : val || 'N/A';
      };

      const fullName = getAttr('displayName') !== 'N/A' ? getAttr('displayName') :
        getAttr('cn') !== 'N/A' ? getAttr('cn') :
          (getAttr('givenName') !== 'N/A' || getAttr('sn') !== 'N/A')
            ? `${getAttr('givenName')} ${getAttr('sn')}`.trim()
            : nameId;

      const info: UserInfo = {
        name: fullName,
        email: getAttr('email') !== 'N/A' ? getAttr('email') : getAttr('mail') !== 'N/A' ? getAttr('mail') : 'N/A',
        preferred_username: getAttr('uid') !== 'N/A' ? getAttr('uid') :
          getAttr('samAccountName') !== 'N/A' ? getAttr('samAccountName') : nameId,
        given_name: getAttr('givenName') !== 'N/A' ? getAttr('givenName') : nameId,
        family_name: getAttr('sn') || 'N/A',
        sub: nameId,
        acr: authnContext,
        amr: [],
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
      setErrorMsg(`Chyba při zpracování SAML response: ${error instanceof Error ? error.message : 'Neznámá chyba'}`);
      setLoading(false);
    }
  }, []);

  // ── Logout ────────────────────────────────────────────────────────────────

  // Reset React stavu (storage maže volající)
  const resetClientState = useCallback((): void => {
    setIsAuthenticated(false);
    setUserInfo(null);
    setUsedClientType(null);
    setSamlAttributes(null);
    setSamlRawXml(null);
    setProtocol(null);
  }, []);

  // Vyčistí jen storage (ponechá zvolené env, aby se uživatel nevracel na začátek)
  const clearAuthStorage = useCallback((): void => {
    const keysToKeep = new Set([STORAGE_ENV_KEY]);
    Object.keys(localStorage).forEach((k) => {
      if (!keysToKeep.has(k)) localStorage.removeItem(k);
    });
    sessionStorage.clear();
  }, []);

  const logoutLocal = useCallback((): void => {
    clearAuthStorage();
    resetClientState();
  }, [clearAuthStorage, resetClientState]);

  const logoutSSO = useCallback((): void => {
    if (!envConfig) { logoutLocal(); return; }
    const usedProto = localStorage.getItem('used_protocol') as Protocol;

    if (usedProto === 'oidc') {
      const idToken = localStorage.getItem('id_token');
      const clientId = oidcClientIdFor(envConfig, usedClientType ?? '1FA');
      const params = new URLSearchParams({
        client_id: clientId,
        post_logout_redirect_uri: window.location.origin,
        ...(idToken ? { id_token_hint: idToken } : {}),
      });
      const logoutUrl = `${envConfig.url}/realms/${envConfig.realm}/protocol/openid-connect/logout?${params.toString()}`;
      clearAuthStorage();
      resetClientState();
      window.location.href = logoutUrl;
      return;
    }

    if (usedProto === 'saml') {
      const samlClientId = samlClientIdFor(envConfig, usedClientType ?? '1FA');
      const nameId = userInfo?.sub || '';
      const requestId = '_' + Math.random().toString(36).substring(2, 18);
      const issueInstant = new Date().toISOString();
      const logoutRequest = `<?xml version="1.0" encoding="UTF-8"?><samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${requestId}" Version="2.0" IssueInstant="${issueInstant}"><saml:Issuer>${samlClientId}</saml:Issuer><saml:NameID>${nameId}</saml:NameID></samlp:LogoutRequest>`;
      const deflated = deflateRaw(logoutRequest);
      let deflatedStr = '';
      for (let i = 0; i < deflated.length; i++) deflatedStr += String.fromCharCode(deflated[i]);
      const samlRequest = encodeURIComponent(btoa(deflatedStr));
      const samlEndpoint = `${envConfig.url}/realms/${envConfig.realm}/protocol/saml`;
      const redirectUrl = `${samlEndpoint}?SAMLRequest=${samlRequest}`;
      clearAuthStorage();
      resetClientState();
      window.location.href = redirectUrl;
      return;
    }

    logoutLocal();
  }, [envConfig, usedClientType, userInfo, clearAuthStorage, resetClientState, logoutLocal]);

  // ── Inicializace / callback handling ──────────────────────────────────────

  const checkAuthStatus = useCallback((): void => {
    clearAuthStorage();
    setLoading(false);
  }, [clearAuthStorage]);

  const parseKeycloakCallback = useCallback((): void => {
    if (!envConfig) { setLoading(false); return; }
    const urlParams = new URLSearchParams(window.location.search);
    const proto = urlParams.get('protocol');

    if (proto === 'saml' || urlParams.has('SAMLResponse') || urlParams.has('SAMLError')) {
      parseSamlCallback();
      return;
    }

    const code = urlParams.get('code');
    const error = urlParams.get('error');
    const errorDescription = urlParams.get('error_description');
    const clientType = (urlParams.get('client_type') as ClientType) || '1FA';

    if (error) {
      setErrorMsg(`Chyba při přihlášení: ${error}\n${errorDescription || ''}`);
      setLoading(false);
      return;
    }
    if (code) {
      const usedCode = localStorage.getItem('used_auth_code');
      if (usedCode === code) { setLoading(false); return; }
      localStorage.setItem('used_auth_code', code);
      exchangeCodeForToken(envConfig, code, clientType);
      return;
    }
    setLoading(false);
  }, [envConfig, exchangeCodeForToken, parseSamlCallback]);

  // Spustíme až po načtení config — pokud je v URL callback, potřebujeme env config
  useEffect(() => {
    if (!config) return;
    const urlParams = new URLSearchParams(window.location.search);
    const hasCallback = urlParams.has('code') || urlParams.has('error') ||
      urlParams.has('SAMLResponse') || urlParams.has('SAMLError') ||
      (urlParams.has('protocol') && urlParams.get('protocol') === 'saml');

    if (hasCallback && envConfig) parseKeycloakCallback();
    else checkAuthStatus();
  }, [config, envConfig, parseKeycloakCallback, checkAuthStatus]);

  // Persistence zvoleného env
  useEffect(() => {
    if (selectedEnv) localStorage.setItem(STORAGE_ENV_KEY, selectedEnv);
  }, [selectedEnv]);

  // ── UI helpery ────────────────────────────────────────────────────────────

  const formatAMR = useCallback((amr: string[]): string => {
    if (!amr || amr.length === 0) return 'N/A';
    const map: { [key: string]: string } = {
      pwd: 'Heslo', sms: 'SMS kód', otp: 'OTP token', mfa: 'Multifaktor',
      sc: 'Smart Card', cert: 'Certifikát', x509: 'X.509 Certifikát',
      webauthn: 'WebAuthn', fido: 'FIDO', u2f: 'U2F',
    };
    return amr.map((m) => map[m] || m.toUpperCase()).join(', ');
  }, []);

  const handleSelectEnv = (env: string) => {
    setSelectedEnv(env);
    setProtocol(null);
    setUsedClientType(null);
  };

  const handleResetEnv = () => {
    localStorage.removeItem(STORAGE_ENV_KEY);
    clearAuthStorage();
    resetClientState();
    setSelectedEnv(null);
  };

  const handleBack = () => {
    if (stage === 'clientType') setProtocol(null);
    else if (stage === 'protocol') handleResetEnv();
  };

  // ── Společné kusy layoutu ─────────────────────────────────────────────────

  const headerNode = (
    <Header
      logo={
        <HeaderLogo
          href="/"
          onClick={(e: React.MouseEvent) => { e.preventDefault(); handleResetEnv(); }}
          logoProps={{ color: SKODA_GREEN, width: 110 }}
        />
      }
      buttons={
        envConfig && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip
              label={envConfig.label}
              size="small"
              sx={{
                bgcolor: SKODA_GREEN,
                color: '#0e3a2f',
                fontWeight: 700,
                letterSpacing: 0.5,
              }}
            />
          </Stack>
        )
      }
    />
  );

  const footerNode = (
    <Footer>
      <Container>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          spacing={1}
          sx={{ py: 2 }}
        >
          <Typography variant="body2" sx={{ opacity: 0.7 }}>
            © {new Date().getFullYear()} ŠKODA AUTO — SIP Demo App
          </Typography>
          <Typography variant="caption" sx={{ opacity: 0.5 }}>
            {envConfig ? `${envConfig.label} · ${envConfig.realm}` : 'Není zvoleno prostředí'}
          </Typography>
        </Stack>
      </Container>
    </Footer>
  );

  // ── Loading / config error guard ──────────────────────────────────────────

  if (configError) {
    return (
      <SkodaThemeProvider globalBaseline>
        <Container maxWidth="sm" sx={{ py: 8 }}>
          <Banner variant="error">
            <Typography variant="h6" sx={{ mb: 1 }}>Chyba načtení konfigurace</Typography>
            <Typography variant="body2">{configError}</Typography>
            <Typography variant="caption" sx={{ mt: 1, display: 'block' }}>
              Zkontroluj soubor <code>public/config.json</code>.
            </Typography>
          </Banner>
        </Container>
      </SkodaThemeProvider>
    );
  }

  if (!config || loading) {
    return (
      <SkodaThemeProvider globalBaseline>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: 2 }}>
          <CircularProgress sx={{ color: SKODA_GREEN }} />
          <Typography variant="body2" sx={{ opacity: 0.7 }}>Načítám…</Typography>
        </Box>
      </SkodaThemeProvider>
    );
  }

  // ── Render obsah podle stavu ──────────────────────────────────────────────

  const renderContent = () => {
    // 1) Přihlášený uživatel
    if (isAuthenticated && userInfo) {
      return renderAuthenticated();
    }
    // 2) Před-login wizard
    if (stage === 'env') return renderEnvSelector();
    if (stage === 'protocol') return renderProtocolSelector();
    return renderClientTypeSelector();
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 1: výběr prostředí
  // ──────────────────────────────────────────────────────────────────────────

  const renderEnvSelector = () => (
    <Container maxWidth="md" sx={{ py: { xs: 4, md: 8 } }}>
      <Stack alignItems="center" spacing={1} sx={{ mb: 4, textAlign: 'center' }}>
        <Logo color={SKODA_GREEN} width={140} />
        <Typography variant="h4" sx={{ mt: 2, fontWeight: 700 }}>SIP Demo App</Typography>
        <Typography variant="body1" sx={{ opacity: 0.75, maxWidth: 520 }}>
          Vyberte prostředí Keycloak (IdP), proti kterému chcete demonstrovat přihlášení.
        </Typography>
      </Stack>

      {errorMsg && (
        <Box sx={{ mb: 3 }}>
          <Banner variant="error">{errorMsg}</Banner>
        </Box>
      )}

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} justifyContent="center">
        {Object.entries(config.environments).map(([key, env]) => (
          <SelectionCard
            key={key}
            icon={<LockIcon sx={{ fontSize: 40, color: SKODA_GREEN }} />}
            title={env.label}
            subtitle={env.realm}
            description={env.url.replace(/^https?:\/\//, '')}
            onClick={() => handleSelectEnv(key)}
          />
        ))}
      </Stack>
    </Container>
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 2: výběr protokolu
  // ──────────────────────────────────────────────────────────────────────────

  const renderProtocolSelector = () => (
    <Container maxWidth="md" sx={{ py: { xs: 4, md: 8 } }}>
      <Button startIcon={<ArrowBackIcon />} onClick={handleBack} sx={{ mb: 3 }}>
        Změnit prostředí
      </Button>

      <Stack alignItems="center" spacing={1} sx={{ mb: 4, textAlign: 'center' }}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>Vyberte protokol</Typography>
        <Typography variant="body1" sx={{ opacity: 0.75 }}>
          Prostředí: <strong>{envConfig?.label}</strong>
        </Typography>
      </Stack>

      {errorMsg && (
        <Box sx={{ mb: 3 }}>
          <Banner variant="error">{errorMsg}</Banner>
        </Box>
      )}

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} justifyContent="center">
        <SelectionCard
          icon={<VpnKeyIcon sx={{ fontSize: 40, color: SKODA_GREEN }} />}
          title="OIDC"
          subtitle="OpenID Connect + PKCE"
          description="Authorization Code flow s PKCE (S256)."
          onClick={() => setProtocol('oidc')}
        />
        <SelectionCard
          icon={<BadgeIcon sx={{ fontSize: 40, color: SKODA_GREEN }} />}
          title="SAML 2.0"
          subtitle="HTTP Redirect Binding"
          description="SP-initiated SSO s deflate + base64 AuthnRequest."
          onClick={() => setProtocol('saml')}
        />
      </Stack>
    </Container>
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 3: výběr úrovně autentizace
  // ──────────────────────────────────────────────────────────────────────────

  const renderClientTypeSelector = () => {
    const onLogin = (t: ClientType) => protocol === 'saml' ? loginWithSaml(t) : loginWithOidc(t);
    return (
      <Container maxWidth="md" sx={{ py: { xs: 4, md: 8 } }}>
        <Button startIcon={<ArrowBackIcon />} onClick={handleBack} sx={{ mb: 3 }}>
          Změnit protokol
        </Button>

        <Stack alignItems="center" spacing={1} sx={{ mb: 4, textAlign: 'center' }}>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>Vyberte úroveň autentizace</Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Chip size="small" label={envConfig?.label} sx={{ bgcolor: SKODA_GREEN, color: '#0e3a2f', fontWeight: 700 }} />
            <Chip size="small" label={protocol === 'saml' ? 'SAML 2.0' : 'OIDC'} variant="outlined" />
          </Stack>
        </Stack>

        {errorMsg && (
          <Box sx={{ mb: 3 }}>
            <Banner variant="error">{errorMsg}</Banner>
          </Box>
        )}

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} justifyContent="center">
          <SelectionCard
            icon={<ShieldIcon sx={{ fontSize: 40, color: '#9ccc65' }} />}
            title="1FA"
            subtitle="Weak client"
            description="Pouze heslo (LoA 1)."
            onClick={() => onLogin('1FA')}
          />
          <SelectionCard
            icon={<ShieldIcon sx={{ fontSize: 40, color: '#ff9800' }} />}
            title="2FA"
            subtitle="Medium client"
            description="Heslo + druhý faktor (LoA 2)."
            onClick={() => onLogin('2FA')}
          />
          <SelectionCard
            icon={<VerifiedUserIcon sx={{ fontSize: 40, color: '#f44336' }} />}
            title="3FA"
            subtitle="Strong client"
            description="Heslo + 2 faktory (LoA 3)."
            onClick={() => onLogin('3FA')}
          />
        </Stack>

        {process.env.NODE_ENV === 'development' && envConfig && (
          <Box sx={{ mt: 4 }}>
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle2">Debug informace</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={0.5}>
                  <Typography variant="caption"><strong>Protokol:</strong> {protocol}</Typography>
                  <Typography variant="caption"><strong>SkodaIDP URL:</strong> {envConfig.url}</Typography>
                  <Typography variant="caption"><strong>Realm:</strong> {envConfig.realm}</Typography>
                  {protocol === 'oidc' ? (
                    <>
                      <Typography variant="caption"><strong>1FA Client:</strong> {envConfig.oidcClient1F}</Typography>
                      <Typography variant="caption"><strong>2FA Client:</strong> {envConfig.oidcClient2F}</Typography>
                      <Typography variant="caption"><strong>3FA Client:</strong> {envConfig.oidcClient3F}</Typography>
                    </>
                  ) : (
                    <>
                      <Typography variant="caption"><strong>1FA SAML Client:</strong> {envConfig.samlClient1F}</Typography>
                      <Typography variant="caption"><strong>2FA SAML Client:</strong> {envConfig.samlClient2F}</Typography>
                      <Typography variant="caption"><strong>3FA SAML Client:</strong> {envConfig.samlClient3F}</Typography>
                    </>
                  )}
                </Stack>
              </AccordionDetails>
            </Accordion>
          </Box>
        )}
      </Container>
    );
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 4: přihlášený uživatel
  // ──────────────────────────────────────────────────────────────────────────

  const renderAuthenticated = () => {
    if (!userInfo || !envConfig) return null;
    const wellKnownUrl = `${envConfig.url}/realms/${envConfig.realm}/.well-known/openid-configuration`;
    const usedClient = protocol === 'saml'
      ? samlClientIdFor(envConfig, usedClientType ?? '1FA')
      : oidcClientIdFor(envConfig, usedClientType ?? '1FA');

    return (
      <Container maxWidth="md" sx={{ py: { xs: 4, md: 6 } }}>
        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          <Chip size="small" label={envConfig.label} sx={{ bgcolor: SKODA_GREEN, color: '#0e3a2f', fontWeight: 700 }} />
          <Chip size="small" label={protocol === 'saml' ? 'SAML 2.0' : 'OIDC'} variant="outlined" />
          {usedClientType && <Chip size="small" label={`${usedClientType} client`} variant="outlined" />}
        </Stack>

        <Typography variant="h4" sx={{ fontWeight: 700, mb: 0.5 }}>Úspěšně přihlášen</Typography>
        <Typography variant="body1" sx={{ opacity: 0.75, mb: 3 }}>Vítejte, {userInfo.name}!</Typography>

        {errorMsg && (
          <Box sx={{ mb: 3 }}>
            <Banner variant="error">{errorMsg}</Banner>
          </Box>
        )}

        <Card variant="outlined" sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>Informace o uživateli</Typography>
            <Stack spacing={1.5} divider={<Divider flexItem />}>
              <InfoRow label="Celé jméno" value={userInfo.name} />
              <InfoRow label="Email" value={userInfo.email} />
              <InfoRow label="Uživatelské jméno" value={userInfo.preferred_username || 'N/A'} />
              {protocol === 'oidc' && (
                <>
                  <InfoRow label="ACR Level" value={<code>{userInfo.acr}</code>} />
                  <InfoRow
                    label="AMR (metody)"
                    value={
                      <>
                        <code>{formatAMR(userInfo.amr || [])}</code>
                        {userInfo.amr && userInfo.amr.length > 0 && (
                          <Typography variant="caption" sx={{ ml: 1, opacity: 0.6 }}>
                            [{userInfo.amr.join(', ')}]
                          </Typography>
                        )}
                      </>
                    }
                  />
                </>
              )}
              <InfoRow label="Použitý klient" value={<code>{usedClient}</code>} />
            </Stack>
          </CardContent>
        </Card>

        {protocol === 'saml' && samlAttributes && (
          <Card variant="outlined" sx={{ mb: 3 }}>
            <CardContent>
              <Typography variant="h6" sx={{ mb: 2 }}>SAML Assertion atributy</Typography>
              <Stack spacing={1.5} divider={<Divider flexItem />}>
                {Object.entries(samlAttributes).map(([key, value]) => (
                  <InfoRow
                    key={key}
                    label={key.startsWith('__') ? key.replace('__', '') : key}
                    value={<code>{Array.isArray(value) ? value.join(', ') : value}</code>}
                  />
                ))}
              </Stack>

              {samlRawXml && (
                <Box sx={{ mt: 2 }}>
                  <Accordion>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Typography variant="subtitle2">Raw SAML XML</Typography>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Box
                        component="pre"
                        sx={{
                          bgcolor: 'rgba(0,0,0,0.04)',
                          p: 2,
                          borderRadius: 1,
                          fontSize: 12,
                          overflow: 'auto',
                          maxHeight: 360,
                        }}
                      >
                        {samlRawXml}
                      </Box>
                    </AccordionDetails>
                  </Accordion>
                </Box>
              )}
            </CardContent>
          </Card>
        )}

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <Button
            onClick={logoutSSO}
            variant="contained"
            size="large"
            startIcon={<LogoutIcon />}
            sx={{ borderRadius: 50, fontWeight: 700, px: 3, bgcolor: SKODA_GREEN, color: '#0e3a2f', '&:hover': { bgcolor: '#5fe899' } }}
          >
            Odhlásit ze SSO (IdP)
          </Button>
          <Button
            onClick={logoutLocal}
            variant="outlined"
            size="large"
            startIcon={<LogoutIcon />}
            sx={{ borderRadius: 50, fontWeight: 600, px: 3 }}
          >
            Odhlásit z aplikace
          </Button>
        </Stack>

        {process.env.NODE_ENV === 'development' && (
          <Box sx={{ mt: 4 }}>
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle2">Debug informace</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={0.5}>
                  <Typography variant="caption"><strong>Protokol:</strong> {protocol}</Typography>
                  <Typography variant="caption"><strong>Sub / NameID:</strong> {userInfo.sub}</Typography>
                  <Typography variant="caption"><strong>ACR:</strong> {userInfo.acr}</Typography>
                  {protocol === 'oidc' && (
                    <Typography variant="caption">
                      <strong>AMR:</strong> {userInfo.amr ? JSON.stringify(userInfo.amr) : 'N/A'}
                    </Typography>
                  )}
                  <Typography variant="caption"><strong>Použitý Client:</strong> {usedClientType}</Typography>
                  <Typography variant="caption"><strong>Realm:</strong> {envConfig.realm}</Typography>
                  {protocol === 'oidc' && (
                    <Typography variant="caption">
                      <strong>Metadata:</strong>{' '}
                      <a href={wellKnownUrl} target="_blank" rel="noreferrer">.well-known</a>
                    </Typography>
                  )}
                </Stack>
              </AccordionDetails>
            </Accordion>
          </Box>
        )}
      </Container>
    );
  };

  // ── Hlavní render ─────────────────────────────────────────────────────────

  return (
    <SkodaThemeProvider globalBaseline>
      <PageLayout header={headerNode} footer={footerNode}>
        {renderContent()}
      </PageLayout>
    </SkodaThemeProvider>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Pomocné komponenty
// ──────────────────────────────────────────────────────────────────────────────

interface SelectionCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  description?: string;
  onClick: () => void;
}

const SelectionCard: React.FC<SelectionCardProps> = ({ icon, title, subtitle, description, onClick }) => (
  <Card
    variant="outlined"
    sx={{
      flex: 1,
      borderRadius: 3,
      transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
      '&:hover': {
        transform: 'translateY(-2px)',
        boxShadow: 3,
        borderColor: SKODA_GREEN,
      },
    }}
  >
    <CardActionArea onClick={onClick} sx={{ p: 3, height: '100%' }}>
      <Stack alignItems="center" spacing={1.5} sx={{ textAlign: 'center' }}>
        {icon}
        <Typography variant="h5" sx={{ fontWeight: 700 }}>{title}</Typography>
        <Typography variant="subtitle2" sx={{ opacity: 0.85 }}>{subtitle}</Typography>
        {description && (
          <Typography variant="body2" sx={{ opacity: 0.65, mt: 0.5 }}>{description}</Typography>
        )}
      </Stack>
    </CardActionArea>
  </Card>
);

interface InfoRowProps {
  label: string;
  value: React.ReactNode;
}

const InfoRow: React.FC<InfoRowProps> = ({ label, value }) => (
  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'flex-start', sm: 'center' }}>
    <Typography variant="body2" sx={{ minWidth: 180, opacity: 0.7 }}>{label}:</Typography>
    <Box sx={{ flex: 1, wordBreak: 'break-word' }}>
      {typeof value === 'string' ? <Typography variant="body2">{value}</Typography> : value}
    </Box>
  </Stack>
);

export default App;
