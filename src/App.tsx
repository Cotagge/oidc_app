import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { deflateRaw, inflateRaw } from 'pako';
import { SkodaThemeProvider, Banner } from '@skodaflow/web-library';
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
import UpgradeIcon from '@mui/icons-material/Upgrade';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
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

// Paleta inspirovaná kcmonitor: tlumená zelená pro buttony/loga,
// status zelená pro indikátory, oranžová a červená pro 2FA / 3FA hierarchii.
const COLORS = {
  greenButton: '#3aaf57',        // primary (buttony, loga, hover border)
  greenButtonHover: '#2d9448',
  greenStatus: '#4cd964',        // status dot, success
  greenStatusBg: '#e8fbed',      // pastel pro chip pozadí
  greenStatusText: '#1a7a32',
  amber: '#f5a623',              // 2FA medium
  amberHover: '#e09600',
  red: '#e74c3c',                // 3FA strong / chyby
  redHover: '#c0392b',
  redBg: '#fdecea',
  textPrimary: '#1a1a1a',
  textSecondary: '#6b6b6b',
  textMuted: '#9a9a9a',
  border: '#e5e5e5',
  bg: '#f5f5f5',
  surface: '#ffffff',
};

const STORAGE_ENV_KEY = 'sip_demo_env';

// ── Helpers pro výběr clientId podle typu ────────────────────────────────────

const oidcClientIdFor = (env: EnvConfig, t: ClientType): string =>
  t === '3FA' ? env.oidcClient3F : t === '2FA' ? env.oidcClient2F : env.oidcClient1F;

const samlClientIdFor = (env: EnvConfig, t: ClientType): string =>
  t === '3FA' ? env.samlClient3F : t === '2FA' ? env.samlClient2F : env.samlClient1F;

// ── Path-based routing ───────────────────────────────────────────────────────
// Každý klient má vlastní cestu, aby šel z venku (monitoring, bookmarky)
// adresovat přímo a Keycloak měl jednoznačnou redirect URI:
//   /oidc/1fa, /oidc/2fa, /oidc/3fa, /saml/1fa, /saml/2fa, /saml/3fa

const clientPath = (protocol: 'oidc' | 'saml', t: ClientType): string =>
  `/${protocol}/${t.toLowerCase()}`;

const parseClientPath = (pathname: string): { protocol: 'oidc' | 'saml'; clientType: ClientType } | null => {
  const m = pathname.match(/^\/(oidc|saml)\/(1fa|2fa|3fa)\/?$/i);
  if (!m) return null;
  const protocol = m[1].toLowerCase() as 'oidc' | 'saml';
  const clientType = m[2].toUpperCase() as ClientType;
  return { protocol, clientType };
};

// Najde env v configu podle OIDC issueru (`iss` claim = `${url}/realms/${realm}`).
// Stejný princip pro SAML <saml:Issuer>, který obsahuje stejný URL.
const findEnvByIssuer = (cfg: AppConfig, issuer: string): { key: string; env: EnvConfig } | null => {
  const normalized = issuer.replace(/\/$/, '');
  for (const [key, env] of Object.entries(cfg.environments)) {
    const expected = `${env.url.replace(/\/$/, '')}/realms/${env.realm}`;
    if (normalized === expected) return { key, env };
  }
  return null;
};

// ──────────────────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [selectedEnv, setSelectedEnv] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<Protocol>(null);
  // usedClientType — zobrazená úroveň autentizace (po step-upu se přepíše dle acr claimu).
  const [usedClientType, setUsedClientType] = useState<ClientType | null>(null);
  // loginClientType — klient, kterému token reálně patří (azp). Pro logout / token endpoint.
  // Po step-upu zůstává stejný (klient se nemění), zatímco usedClientType odráží nové LoA.
  const [loginClientType, setLoginClientType] = useState<ClientType | null>(null);

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [samlAttributes, setSamlAttributes] = useState<SamlAttributes | null>(null);
  const [samlRawXml, setSamlRawXml] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Pokud uživatel přišel rovnou na /oidc/2fa (bez code), zachytíme záměr.
  // Po výběru env z rozcestníku auto-spustíme login pro tuto kombinaci.
  const [pendingDirectLogin, setPendingDirectLogin] = useState<{ protocol: 'oidc' | 'saml'; clientType: ClientType } | null>(null);

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
      window.history.replaceState({}, document.title, '/');
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
      window.history.replaceState({}, document.title, '/');
      localStorage.removeItem('used_auth_code');
      setLoading(false);
    } catch {
      const accessToken = localStorage.getItem('access_token');
      if (accessToken) fetchUserInfo(env, accessToken);
      else setLoading(false);
    }
  }, [fetchUserInfo]);

  // Pokud je env známé (ruční login), předá se přímo. Pokud ne (monitoring přijde
  // rovnou na /oidc/1fa?code=...), pokusíme se ho odvodit z `iss` v ID tokenu;
  // než ho dostaneme, musíme token endpoint volat na URL z config.json — bez
  // env nemůžeme. Proto když env chybí, projdeme všechna env z configu a najdeme
  // to, na které code patří (token endpoint vrátí 200 jen pro správné).
  const exchangeCodeForToken = useCallback(async (
    cfg: AppConfig,
    knownEnv: { key: string; env: EnvConfig } | null,
    code: string,
    clientType: ClientType,
  ): Promise<void> => {
    try {
      const codeVerifier = localStorage.getItem('code_verifier');
      if (!codeVerifier) throw new Error('Code verifier not found in localStorage');
      const redirectUri = `${window.location.origin}${clientPath('oidc', clientType)}`;

      // Seznam env k vyzkoušení: známé env první, jinak všechny.
      const candidates: Array<{ key: string; env: EnvConfig }> = knownEnv
        ? [knownEnv]
        : Object.entries(cfg.environments).map(([key, env]) => ({ key, env }));

      let tokens: any = null;
      let resolved: { key: string; env: EnvConfig } | null = null;
      let lastError = '';

      for (const cand of candidates) {
        const tokenUrl = `${cand.env.url}/realms/${cand.env.realm}/protocol/openid-connect/token`;
        const clientId = oidcClientIdFor(cand.env, clientType);
        const resp = await fetch(tokenUrl, {
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
        if (resp.ok) {
          tokens = await resp.json();
          resolved = cand;
          break;
        }
        try { lastError = JSON.stringify(await resp.json()); } catch { lastError = `${resp.status}`; }
      }

      if (!tokens || !resolved) {
        throw new Error(`Token request failed across all environments: ${lastError}`);
      }

      // Pokud máme ID token, ověříme env z `iss` — autoritativní zdroj.
      if (tokens.id_token) {
        try {
          const payload = JSON.parse(atob(tokens.id_token.split('.')[1]));
          if (payload.iss) {
            const fromIss = findEnvByIssuer(cfg, payload.iss);
            if (fromIss) resolved = fromIss;
          }
        } catch { /* ponecháme resolved z fetch loopu */ }
      }

      localStorage.setItem('access_token', tokens.access_token);
      if (tokens.id_token) localStorage.setItem('id_token', tokens.id_token);
      if (tokens.refresh_token) localStorage.setItem('refresh_token', tokens.refresh_token);

      // Pokud šlo o step-up, odvodíme efektivní ClientType z acr claimu.
      // SkodaIDP používá named LoA hodnoty mapované přes acr.loa.map:
      //   weak/1 → 1FA, medium/2 → 2FA, strong/3 → 3FA.
      // Klient zůstává 1FA — měníme jen UI label a LoA chip.
      let effectiveType: ClientType = clientType;
      if (localStorage.getItem('oidc_stepup_pending') === '1' && tokens.id_token) {
        try {
          const payload = JSON.parse(atob(tokens.id_token.split('.')[1]));
          const acr = String(payload.acr ?? '').toLowerCase();
          if (acr === '3' || acr === 'strong') effectiveType = '3FA';
          else if (acr === '2' || acr === 'medium') effectiveType = '2FA';
        } catch { /* ponecháme původní */ }
        localStorage.removeItem('oidc_stepup_pending');
      }

      localStorage.setItem('used_client_type', effectiveType);
      localStorage.setItem('login_client_type', clientType);
      localStorage.setItem('used_protocol', 'oidc');
      localStorage.setItem(STORAGE_ENV_KEY, resolved.key);
      localStorage.removeItem('code_verifier');
      localStorage.removeItem('code_challenge');
      setSelectedEnv(resolved.key);
      setUsedClientType(effectiveType);
      setLoginClientType(clientType);
      setProtocol('oidc');

      if (tokens.id_token) parseUserInfoFromIdToken(resolved.env, tokens.id_token);
      else await fetchUserInfo(resolved.env, tokens.access_token);
    } catch (error) {
      setErrorMsg(`Chyba při dokončování přihlášení: ${error instanceof Error ? error.message : 'Neznámá chyba'}`);
      setLoading(false);
    }
  }, [parseUserInfoFromIdToken, fetchUserInfo]);

  // Pokud je předáno `acrValues`, jde o step-up:
  //  - přidáme acr_values do auth requestu
  //  - vynecháme prompt=login a max_age=0, aby Keycloak využil existující SSO session
  //    a vyžádal jen chybějící faktor (Conditional flow s podmínkou na LoA).
  const loginWithOidc = useCallback(async (clientType: ClientType, acrValues?: string): Promise<void> => {
    if (!envConfig) return;
    try {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      localStorage.setItem('code_verifier', codeVerifier);
      localStorage.setItem('code_challenge', codeChallenge);

      const clientId = oidcClientIdFor(envConfig, clientType);
      const redirectUri = `${window.location.origin}${clientPath('oidc', clientType)}`;

      const isStepUp = !!acrValues;
      let authUrl = `${envConfig.url}/realms/${envConfig.realm}/protocol/openid-connect/auth` +
        `?client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=openid profile email microprofile-jwt amr` +
        `&code_challenge=${codeChallenge}` +
        `&code_challenge_method=S256` +
        `&state=${Date.now()}`;

      if (isStepUp) {
        authUrl += `&acr_values=${encodeURIComponent(acrValues!)}`;
        localStorage.setItem('oidc_stepup_pending', '1');
      } else {
        authUrl += `&prompt=login&max_age=0`;
      }

      window.location.href = authUrl;
    } catch (error) {
      setErrorMsg('Chyba při přípravě přihlášení: ' + (error instanceof Error ? error.message : 'Neznámá chyba'));
    }
  }, [envConfig, generateCodeVerifier, generateCodeChallenge]);

  // Step-up z 1FA na 2FA: re-login proti TÉMUŽ 1FA klientovi s acr_values="medium strong".
  // SkodaIDP mapuje weak/medium/strong na LoA 1/2/3 přes acr.loa.map; "medium strong"
  // znamená "akceptuju 2FA i 3FA", což je standardní step-up zápis používaný napříč
  // Skoda aplikacemi. Keycloak vynutí přidání druhého faktoru (Conditional flow).
  const stepUpToTwoFactor = useCallback((): void => {
    loginWithOidc('1FA', 'medium strong');
  }, [loginWithOidc]);

  // ── SAML flow ─────────────────────────────────────────────────────────────

  const loginWithSaml = useCallback(async (clientType: ClientType): Promise<void> => {
    if (!envConfig) return;
    try {
      const samlClientId = samlClientIdFor(envConfig, clientType);
      const acsUrl = `${window.location.origin}${clientPath('saml', clientType)}`;
      const requestId = '_' + Math.random().toString(36).substring(2, 18);
      const issueInstant = new Date().toISOString();
      const authnRequest = `<?xml version="1.0" encoding="UTF-8"?><samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${requestId}" Version="2.0" IssueInstant="${issueInstant}" AssertionConsumerServiceURL="${acsUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"><saml:Issuer>${samlClientId}</saml:Issuer></samlp:AuthnRequest>`;

      const deflated = deflateRaw(authnRequest);
      let deflatedStr = '';
      for (let i = 0; i < deflated.length; i++) deflatedStr += String.fromCharCode(deflated[i]);
      const samlRequest = encodeURIComponent(btoa(deflatedStr));

      const samlEndpoint = `${envConfig.url}/realms/${envConfig.realm}/protocol/saml`;
      const redirectUrl = `${samlEndpoint}?SAMLRequest=${samlRequest}`;

      window.location.href = redirectUrl;
    } catch (error) {
      setErrorMsg('Chyba při přípravě SAML přihlášení: ' + (error instanceof Error ? error.message : 'Neznámá chyba'));
    }
  }, [envConfig]);

  const parseSamlCallback = useCallback((cfg: AppConfig, clientType: ClientType): void => {
    const urlParams = new URLSearchParams(window.location.search);
    const samlResponse = urlParams.get('SAMLResponse');
    const samlError = urlParams.get('SAMLError');

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

      // Env z <saml:Issuer> v Response (= URL realmu, který Assertion vystavil).
      const issuer = xmlDoc.querySelector('Issuer')?.textContent?.trim() || '';
      const resolvedEnv = issuer ? findEnvByIssuer(cfg, issuer) : null;
      if (resolvedEnv) {
        localStorage.setItem(STORAGE_ENV_KEY, resolvedEnv.key);
        setSelectedEnv(resolvedEnv.key);
      }

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
      window.history.replaceState({}, document.title, '/');
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
    setLoginClientType(null);
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
    // Logout musí použít klienta, kterému token patří (azp), ne aktuálně zobrazené LoA.
    // Po step-upu zůstává klient stejný jako při původním loginu, jen acr v tokenu vzroste.
    const tokenClientType = loginClientType ?? usedClientType ?? '1FA';

    if (usedProto === 'oidc') {
      const idToken = localStorage.getItem('id_token');
      const clientId = oidcClientIdFor(envConfig, tokenClientType);
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
      const samlClientId = samlClientIdFor(envConfig, tokenClientType);
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
  }, [envConfig, usedClientType, loginClientType, userInfo, clearAuthStorage, resetClientState, logoutLocal]);

  // ── Inicializace / callback handling ──────────────────────────────────────

  const checkAuthStatus = useCallback((): void => {
    clearAuthStorage();
    setLoading(false);
  }, [clearAuthStorage]);

  // Callback handling řídí path: protokol + clientType bere z pathname (např. /oidc/1fa).
  // Env je odvozeno z `iss` (OIDC) nebo <Issuer> (SAML) až po dekódování tokenu,
  // takže envConfig není potřeba dopředu — viz exchangeCodeForToken.
  const parseKeycloakCallback = useCallback((cfg: AppConfig): void => {
    const route = parseClientPath(window.location.pathname);
    if (!route) { setLoading(false); return; }

    const urlParams = new URLSearchParams(window.location.search);

    if (route.protocol === 'saml') {
      parseSamlCallback(cfg, route.clientType);
      return;
    }

    const code = urlParams.get('code');
    const error = urlParams.get('error');
    const errorDescription = urlParams.get('error_description');

    if (error) {
      setErrorMsg(`Chyba při přihlášení: ${error}\n${errorDescription || ''}`);
      setLoading(false);
      return;
    }
    if (code) {
      const usedCode = localStorage.getItem('used_auth_code');
      if (usedCode === code) { setLoading(false); return; }
      localStorage.setItem('used_auth_code', code);
      const storedEnv = localStorage.getItem(STORAGE_ENV_KEY);
      const knownEnv = storedEnv && cfg.environments[storedEnv]
        ? { key: storedEnv, env: cfg.environments[storedEnv] }
        : null;
      exchangeCodeForToken(cfg, knownEnv, code, route.clientType);
      return;
    }
    setLoading(false);
  }, [exchangeCodeForToken, parseSamlCallback]);

  // Po načtení configu rozhodneme:
  //  - callback (URL obsahuje code / SAMLResponse / error) → parseKeycloakCallback
  //  - cesta /oidc|saml/1fa|2fa|3fa bez callback paramů → pending direct login
  //    (po vybrání env se auto-spustí login)
  //  - jinak rozcestník
  useEffect(() => {
    if (!config) return;
    const urlParams = new URLSearchParams(window.location.search);
    const hasCallback = urlParams.has('code') || urlParams.has('error') ||
      urlParams.has('SAMLResponse') || urlParams.has('SAMLError');

    if (hasCallback) {
      parseKeycloakCallback(config);
      return;
    }

    const route = parseClientPath(window.location.pathname);
    if (route) {
      // Storage čistíme proto, aby pending login startoval s čistým stavem
      // (ne na zbytcích z minulé session) — env z localStorage zachováme.
      clearAuthStorage();
      resetClientState();
      setPendingDirectLogin(route);
      setLoading(false);
      return;
    }

    checkAuthStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // Persistence zvoleného env
  useEffect(() => {
    if (selectedEnv) localStorage.setItem(STORAGE_ENV_KEY, selectedEnv);
  }, [selectedEnv]);

  // Auto-trigger loginu pro pending direct entry. Spustí se jakmile máme envConfig.
  useEffect(() => {
    if (!pendingDirectLogin || !envConfig) return;
    const { protocol: p, clientType } = pendingDirectLogin;
    setPendingDirectLogin(null);
    if (p === 'oidc') loginWithOidc(clientType);
    else loginWithSaml(clientType);
  }, [pendingDirectLogin, envConfig, loginWithOidc, loginWithSaml]);

  // Pokud uživatel přijde na callback URL (např. /oidc/1fa) a klikne na logo
  // ("SIP Demo App"), chceme se vrátit na rozcestník. handleResetEnv smaže env,
  // ale URL stále obsahuje /oidc/1fa — manuálně vyčistíme pathname.

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
    setPendingDirectLogin(null);
    if (window.location.pathname !== '/') {
      window.history.replaceState({}, document.title, '/');
    }
  };

  const handleBack = () => {
    if (stage === 'clientType') setProtocol(null);
    else if (stage === 'protocol') handleResetEnv();
  };

  // ── Společné kusy layoutu ─────────────────────────────────────────────────

  // Kompaktní top bar (nepoužívá Skoda Header — to by zdvojovalo logo).
  // Vlevo: název appky + drobný status dot, vpravo: chip aktivního prostředí.
  const topBar = (
    <Box
      sx={{
        bgcolor: COLORS.surface,
        borderBottom: `1px solid ${COLORS.border}`,
        px: { xs: 2, md: 4 },
        py: 1.5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <Box
          sx={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            bgcolor: envConfig ? COLORS.greenStatus : COLORS.textMuted,
            boxShadow: envConfig ? `0 0 6px ${COLORS.greenStatus}` : 'none',
          }}
        />
        <Typography
          component="button"
          onClick={handleResetEnv}
          sx={{
            fontWeight: 700,
            fontSize: '1rem',
            color: COLORS.textPrimary,
            background: 'none',
            border: 'none',
            p: 0,
            cursor: 'pointer',
            letterSpacing: 0.2,
            '&:hover': { color: COLORS.greenButton },
          }}
        >
          SIP Demo App
        </Typography>
      </Box>
      {envConfig && (
        <Chip
          label={envConfig.label}
          size="small"
          sx={{
            bgcolor: COLORS.greenStatusBg,
            color: COLORS.greenStatusText,
            fontWeight: 700,
            letterSpacing: 0.5,
            fontSize: '0.72rem',
          }}
        />
      )}
    </Box>
  );

  // Tenký řádek místo dark Footeru.
  const bottomBar = (
    <Box
      sx={{
        borderTop: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.surface,
        px: { xs: 2, md: 4 },
        py: 1.25,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 1,
        flexWrap: 'wrap',
      }}
    >
      <Typography variant="caption" sx={{ color: COLORS.textMuted, fontSize: '0.72rem' }}>
        © {new Date().getFullYear()} ŠKODA AUTO — SIP Demo App
      </Typography>
      <Typography variant="caption" sx={{ color: COLORS.textMuted, fontSize: '0.72rem' }}>
        {envConfig ? `${envConfig.label} · ${envConfig.realm}` : 'Není zvoleno prostředí'}
      </Typography>
    </Box>
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
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: 2, bgcolor: COLORS.bg }}>
          <CircularProgress sx={{ color: COLORS.greenButton }} />
          <Typography variant="body2" sx={{ color: COLORS.textSecondary }}>Načítám…</Typography>
        </Box>
      </SkodaThemeProvider>
    );
  }

  // ── Render obsah podle stavu ──────────────────────────────────────────────

  const renderContent = () => {
    if (isAuthenticated && userInfo) return renderAuthenticated();
    if (stage === 'env') return renderEnvSelector();
    if (stage === 'protocol') return renderProtocolSelector();
    return renderClientTypeSelector();
  };

  // Univerzální chip-back tlačítko ve stylu kcmonitor.
  const BackChip: React.FC<{ label: string }> = ({ label }) => (
    <Button
      onClick={handleBack}
      startIcon={<ArrowBackIcon sx={{ fontSize: 16 }} />}
      sx={{
        height: 32,
        borderRadius: '16px',
        bgcolor: COLORS.greenStatusBg,
        color: COLORS.greenStatusText,
        fontWeight: 700,
        textTransform: 'none',
        px: 1.5,
        fontSize: '0.78rem',
        '&:hover': { bgcolor: '#d4f4dd' },
      }}
    >
      {label}
    </Button>
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 1: výběr prostředí
  // ──────────────────────────────────────────────────────────────────────────

  const renderEnvSelector = () => (
    <Container maxWidth="lg" sx={{ py: { xs: 3, md: 5 } }}>
      <Stack spacing={0.5} sx={{ mb: 4 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
          Vyberte prostředí
        </Typography>
        <Typography variant="body2" sx={{ color: COLORS.textSecondary }}>
          Zvolte Keycloak (IdP), proti kterému chcete demonstrovat přihlášení.
        </Typography>
      </Stack>

      {errorMsg && (
        <Box sx={{ mb: 3 }}>
          <Banner variant="error">{errorMsg}</Banner>
        </Box>
      )}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' },
          gap: 2,
        }}
      >
        {Object.entries(config.environments).map(([key, env]) => (
          <EnvCard
            key={key}
            label={env.label}
            realm={env.realm}
            host={env.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            onClick={() => handleSelectEnv(key)}
          />
        ))}
      </Box>
    </Container>
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 2: výběr protokolu
  // ──────────────────────────────────────────────────────────────────────────

  const renderProtocolSelector = () => (
    <Container maxWidth="lg" sx={{ py: { xs: 3, md: 5 } }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 3 }}>
        <BackChip label="Zpět" />
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: COLORS.greenStatus }} />
        <Typography variant="body2" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
          {envConfig?.label}
        </Typography>
      </Stack>

      <Stack spacing={0.5} sx={{ mb: 4 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
          Vyberte protokol
        </Typography>
        <Typography variant="body2" sx={{ color: COLORS.textSecondary }}>
          OIDC nebo SAML 2.0 — vybraný protokol určuje login flow.
        </Typography>
      </Stack>

      {errorMsg && (
        <Box sx={{ mb: 3 }}>
          <Banner variant="error">{errorMsg}</Banner>
        </Box>
      )}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 2,
        }}
      >
        <ProtocolCard
          icon={<VpnKeyIcon sx={{ fontSize: 28, color: COLORS.greenButton }} />}
          title="OIDC"
          subtitle="OpenID Connect + PKCE"
          description="Authorization Code flow s PKCE (S256)."
          onClick={() => setProtocol('oidc')}
        />
        <ProtocolCard
          icon={<BadgeIcon sx={{ fontSize: 28, color: COLORS.greenButton }} />}
          title="SAML 2.0"
          subtitle="HTTP Redirect Binding"
          description="SP-initiated SSO s deflate + base64 AuthnRequest."
          onClick={() => setProtocol('saml')}
        />
      </Box>
    </Container>
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 3: výběr úrovně autentizace (pill tlačítka v zelená/oranžová/červená)
  // ──────────────────────────────────────────────────────────────────────────

  const renderClientTypeSelector = () => {
    const onLogin = (t: ClientType) => protocol === 'saml' ? loginWithSaml(t) : loginWithOidc(t);
    return (
      <Container maxWidth="sm" sx={{ py: { xs: 3, md: 5 } }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 3 }}>
          <BackChip label="Zpět" />
          <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: COLORS.greenStatus }} />
          <Typography variant="body2" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
            {envConfig?.label}
          </Typography>
          <Typography variant="body2" sx={{ color: COLORS.textMuted }}>·</Typography>
          <Typography variant="body2" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
            {protocol === 'saml' ? 'SAML 2.0' : 'OIDC'}
          </Typography>
        </Stack>

        <Card variant="outlined" sx={{ borderColor: COLORS.border, borderRadius: 2, p: { xs: 3, md: 4 } }}>
          <Stack spacing={0.5} sx={{ mb: 3, textAlign: 'center' }}>
            <Typography variant="h5" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
              Login to Demo app
            </Typography>
            <Typography variant="body2" sx={{ color: COLORS.textSecondary }}>
              Vyberte úroveň autentizace
            </Typography>
          </Stack>

          {errorMsg && (
            <Box sx={{ mb: 3 }}>
              <Banner variant="error">{errorMsg}</Banner>
            </Box>
          )}

          <Stack spacing={1.5}>
            <PillButton
              onClick={() => onLogin('1FA')}
              bg={COLORS.greenButton}
              hoverBg={COLORS.greenButtonHover}
              text="#fff"
              label="Weak client (1FA)"
            />
            <PillButton
              onClick={() => onLogin('2FA')}
              bg={COLORS.amber}
              hoverBg={COLORS.amberHover}
              text={COLORS.textPrimary}
              label="Medium client (2FA)"
            />
            <PillButton
              onClick={() => onLogin('3FA')}
              bg={COLORS.red}
              hoverBg={COLORS.redHover}
              text="#fff"
              label="Strong client (3FA)"
            />
          </Stack>
        </Card>

        {process.env.NODE_ENV === 'development' && envConfig && (
          <Box sx={{ mt: 3 }}>
            <Accordion sx={{ bgcolor: 'transparent', boxShadow: 'none', '&:before': { display: 'none' } }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle2" sx={{ color: COLORS.textSecondary }}>
                  Debug informace
                </Typography>
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

    // 2FA a 3FA odemykají citlivá pole; SAML bere jako "elevated", protože ten neřešíme step-upem.
    const isElevated = usedClientType === '2FA' || usedClientType === '3FA' || protocol === 'saml';

    return (
      <Container maxWidth="lg" sx={{ py: { xs: 3, md: 5 } }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 3 }}>
          <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: COLORS.greenStatus }} />
          <Typography variant="body2" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
            {envConfig.label}
          </Typography>
          <Typography variant="body2" sx={{ color: COLORS.textMuted }}>·</Typography>
          <Typography variant="body2" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
            {protocol === 'saml' ? 'SAML 2.0' : 'OIDC'}
          </Typography>
          {usedClientType && (
            <>
              <Typography variant="body2" sx={{ color: COLORS.textMuted }}>·</Typography>
              <Typography variant="body2" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
                {usedClientType}
              </Typography>
            </>
          )}
        </Stack>

        {/* Status banner: úspěšné přihlášení */}
        <Card variant="outlined" sx={{ mb: 3, borderColor: COLORS.border, borderRadius: 2 }}>
          <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2, py: '20px !important' }}>
            <Box
              sx={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                bgcolor: COLORS.greenStatus,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 20,
                fontWeight: 700,
              }}
            >
              ✓
            </Box>
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
                Úspěšně přihlášen
              </Typography>
              <Typography variant="caption" sx={{ color: COLORS.textSecondary }}>
                Vítejte, {userInfo.name}
              </Typography>
            </Box>
          </CardContent>
        </Card>

        {errorMsg && (
          <Box sx={{ mb: 3 }}>
            <Banner variant="error">{errorMsg}</Banner>
          </Box>
        )}

        {/* 1FA: upozornění, že část profilu je zamčená za step-upem */}
        {isElevated === false && protocol === 'oidc' && (
          <Card
            variant="outlined"
            sx={{
              mb: 3,
              borderColor: COLORS.amber,
              borderRadius: 2,
              bgcolor: '#fff8eb',
            }}
          >
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2, py: '16px !important' }}>
              <LockOutlinedIcon sx={{ color: COLORS.amber, fontSize: 28 }} />
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
                  Některé údaje jsou skryté
                </Typography>
                <Typography variant="caption" sx={{ color: COLORS.textSecondary }}>
                  Pro zobrazení plného profilu proveďte step-up na 2FA.
                </Typography>
              </Box>
            </CardContent>
          </Card>
        )}

        {/* Informace o uživateli */}
        <Card variant="outlined" sx={{ mb: 3, borderColor: COLORS.border, borderRadius: 2 }}>
          <CardContent sx={{ p: 0 }}>
            <Box
              sx={{
                px: 3,
                py: 2,
                borderBottom: `1px solid ${COLORS.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1,
              }}
            >
              <Typography variant="subtitle1" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
                Informace o uživateli
              </Typography>
              <Chip
                label={isElevated ? 'Plný profil' : 'Veřejné údaje'}
                size="small"
                sx={{
                  bgcolor: isElevated ? COLORS.greenStatusBg : '#fff3d6',
                  color: isElevated ? COLORS.greenStatusText : '#8a5a00',
                  fontWeight: 700,
                  fontSize: '0.7rem',
                  letterSpacing: 0.4,
                }}
              />
            </Box>
            <Stack divider={<Divider />}>
              <InfoRow label="Celé jméno" value={userInfo.name} />
              <InfoRow label="Uživatelské jméno" value={userInfo.preferred_username || 'N/A'} />
              {protocol === 'oidc' && (
                <InfoRow label="ACR Level" value={<code>{userInfo.acr}</code>} />
              )}
              <InfoRow label="Použitý klient" value={<code>{usedClient}</code>} />
              {/* Citlivé údaje odemčené step-upem na 2FA+ */}
              {isElevated && (
                <>
                  <InfoRow label="Email" value={userInfo.email} />
                  <InfoRow label="Sub / NameID" value={<code>{userInfo.sub}</code>} />
                  {protocol === 'oidc' && (
                    <InfoRow
                      label="AMR (metody)"
                      value={
                        <>
                          <code>{formatAMR(userInfo.amr || [])}</code>
                          {userInfo.amr && userInfo.amr.length > 0 && (
                            <Typography variant="caption" sx={{ ml: 1, color: COLORS.textMuted }}>
                              [{userInfo.amr.join(', ')}]
                            </Typography>
                          )}
                        </>
                      }
                    />
                  )}
                </>
              )}
            </Stack>
          </CardContent>
        </Card>

        {/* SAML atributy */}
        {protocol === 'saml' && samlAttributes && (
          <Card variant="outlined" sx={{ mb: 3, borderColor: COLORS.border, borderRadius: 2 }}>
            <CardContent sx={{ p: 0 }}>
              <Box sx={{ px: 3, py: 2, borderBottom: `1px solid ${COLORS.border}` }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, color: COLORS.textPrimary }}>
                  SAML Assertion atributy
                </Typography>
              </Box>
              <Stack divider={<Divider />}>
                {Object.entries(samlAttributes).map(([key, value]) => (
                  <InfoRow
                    key={key}
                    label={key.startsWith('__') ? key.replace('__', '') : key}
                    value={<code>{Array.isArray(value) ? value.join(', ') : value}</code>}
                  />
                ))}
              </Stack>

              {samlRawXml && (
                <Box sx={{ p: 2 }}>
                  <Accordion sx={{ bgcolor: 'transparent', boxShadow: 'none', '&:before': { display: 'none' } }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Typography variant="subtitle2" sx={{ color: COLORS.textSecondary }}>Raw SAML XML</Typography>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Box
                        component="pre"
                        sx={{
                          bgcolor: '#1a1a1a',
                          color: '#e0e0e0',
                          p: 2,
                          borderRadius: 1,
                          fontSize: 11,
                          overflow: 'auto',
                          maxHeight: 360,
                          fontFamily: '"SF Mono", Monaco, "Cascadia Code", Consolas, monospace',
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

        {/* Akce: step-up + logout */}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          {protocol === 'oidc' && usedClientType === '1FA' && (
            <Button
              onClick={stepUpToTwoFactor}
              variant="contained"
              startIcon={<UpgradeIcon />}
              sx={{
                borderRadius: '24px',
                fontWeight: 700,
                textTransform: 'none',
                px: 3,
                py: 1,
                bgcolor: COLORS.amber,
                color: COLORS.textPrimary,
                boxShadow: 'none',
                '&:hover': { bgcolor: COLORS.amberHover, boxShadow: 'none' },
              }}
            >
              Step-up na 2FA
            </Button>
          )}
          <Button
            onClick={logoutSSO}
            variant="contained"
            startIcon={<LogoutIcon />}
            sx={{
              borderRadius: '24px',
              fontWeight: 700,
              textTransform: 'none',
              px: 3,
              py: 1,
              bgcolor: COLORS.greenButton,
              color: '#fff',
              '&:hover': { bgcolor: COLORS.greenButtonHover },
            }}
          >
            Odhlásit ze SSO (IdP)
          </Button>
          <Button
            onClick={logoutLocal}
            variant="outlined"
            startIcon={<LogoutIcon />}
            sx={{
              borderRadius: '24px',
              fontWeight: 600,
              textTransform: 'none',
              px: 3,
              py: 1,
              borderColor: COLORS.border,
              color: COLORS.textSecondary,
              '&:hover': { borderColor: COLORS.greenButton, bgcolor: COLORS.greenStatusBg, color: COLORS.greenStatusText },
            }}
          >
            Odhlásit z aplikace
          </Button>
        </Stack>

        {/* Debug */}
        {process.env.NODE_ENV === 'development' && (
          <Box sx={{ mt: 3 }}>
            <Accordion sx={{ bgcolor: 'transparent', boxShadow: 'none', '&:before': { display: 'none' } }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle2" sx={{ color: COLORS.textSecondary }}>Debug informace</Typography>
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
                      <a href={wellKnownUrl} target="_blank" rel="noreferrer" style={{ color: COLORS.greenButton }}>.well-known</a>
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
      <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', bgcolor: COLORS.bg }}>
        {topBar}
        <Box sx={{ flex: 1 }}>{renderContent()}</Box>
        {bottomBar}
      </Box>
    </SkodaThemeProvider>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Pomocné komponenty (kcmonitor styl)
// ──────────────────────────────────────────────────────────────────────────────

// EnvCard — karta prostředí ve stylu kcmonitor EnvironmentCard:
// silný 2px border, status dot + label nahoře, drobné chips s realm, hover = zelený border.
interface EnvCardProps {
  label: string;
  realm: string;
  host: string;
  onClick: () => void;
}

const EnvCard: React.FC<EnvCardProps> = ({ label, realm, host, onClick }) => (
  <Card
    sx={{
      border: `2px solid ${COLORS.border}`,
      borderRadius: 2,
      bgcolor: COLORS.surface,
      transition: 'border-color 0.2s, box-shadow 0.2s',
      '&:hover': {
        borderColor: COLORS.greenStatus,
        boxShadow: '0 4px 12px rgba(74, 217, 100, 0.15)',
      },
    }}
  >
    <CardActionArea onClick={onClick}>
      <CardContent sx={{ py: 2.5, px: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Box
            sx={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              bgcolor: COLORS.greenStatus,
              boxShadow: `0 0 6px ${COLORS.greenStatus}`,
            }}
          />
          <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '1.1rem', color: COLORS.textPrimary }}>
            {label}
          </Typography>
        </Box>
        <Stack direction="row" spacing={0.75} sx={{ mb: 1.25, flexWrap: 'wrap', gap: 0.5 }}>
          <Chip
            label={realm}
            size="small"
            variant="outlined"
            sx={{ height: 20, fontSize: '0.68rem', borderColor: COLORS.border, color: COLORS.textSecondary }}
          />
        </Stack>
        <Typography variant="caption" sx={{ color: COLORS.textMuted, fontSize: '0.72rem', wordBreak: 'break-all' }}>
          {host}
        </Typography>
      </CardContent>
    </CardActionArea>
  </Card>
);

// ProtocolCard — větší vodorovná karta s ikonkou vlevo.
interface ProtocolCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  description: string;
  onClick: () => void;
}

const ProtocolCard: React.FC<ProtocolCardProps> = ({ icon, title, subtitle, description, onClick }) => (
  <Card
    sx={{
      border: `2px solid ${COLORS.border}`,
      borderRadius: 2,
      bgcolor: COLORS.surface,
      transition: 'border-color 0.2s, box-shadow 0.2s',
      '&:hover': {
        borderColor: COLORS.greenStatus,
        boxShadow: '0 4px 12px rgba(74, 217, 100, 0.15)',
      },
    }}
  >
    <CardActionArea onClick={onClick}>
      <CardContent sx={{ display: 'flex', gap: 2, py: 2.5, px: 2.5, alignItems: 'center' }}>
        <Box
          sx={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            bgcolor: COLORS.greenStatusBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {icon}
        </Box>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '1.05rem', color: COLORS.textPrimary, lineHeight: 1.2 }}>
            {title}
          </Typography>
          <Typography variant="caption" sx={{ color: COLORS.textSecondary, display: 'block', mt: 0.25 }}>
            {subtitle}
          </Typography>
          <Typography variant="caption" sx={{ color: COLORS.textMuted, display: 'block', mt: 0.5, fontSize: '0.72rem' }}>
            {description}
          </Typography>
        </Box>
      </CardContent>
    </CardActionArea>
  </Card>
);

// PillButton — výrazné barevné pill tlačítko pro 1FA/2FA/3FA.
interface PillButtonProps {
  label: string;
  bg: string;
  hoverBg: string;
  text: string;
  onClick: () => void;
}

const PillButton: React.FC<PillButtonProps> = ({ label, bg, hoverBg, text, onClick }) => (
  <Button
    onClick={onClick}
    fullWidth
    sx={{
      bgcolor: bg,
      color: text,
      borderRadius: '50px',
      py: 1.5,
      fontWeight: 700,
      fontSize: '1rem',
      textTransform: 'none',
      boxShadow: 'none',
      '&:hover': { bgcolor: hoverBg, boxShadow: 'none' },
    }}
  >
    {label}
  </Button>
);

// InfoRow — řádek s labelem a hodnotou, padding místo Stack-spacingu (vypadá víc tabulkově).
interface InfoRowProps {
  label: string;
  value: React.ReactNode;
}

const InfoRow: React.FC<InfoRowProps> = ({ label, value }) => (
  <Box
    sx={{
      display: 'flex',
      flexDirection: { xs: 'column', sm: 'row' },
      alignItems: { xs: 'flex-start', sm: 'center' },
      gap: { xs: 0.5, sm: 2 },
      px: 3,
      py: 1.5,
    }}
  >
    <Typography
      variant="body2"
      sx={{ minWidth: 180, color: COLORS.textSecondary, fontSize: '0.85rem' }}
    >
      {label}
    </Typography>
    <Box sx={{ flex: 1, wordBreak: 'break-word' }}>
      {typeof value === 'string'
        ? <Typography variant="body2" sx={{ color: COLORS.textPrimary, fontSize: '0.9rem' }}>{value}</Typography>
        : value}
    </Box>
  </Box>
);

export default App;
