import React, { useState, useEffect, useCallback, useMemo } from 'react';
import './App.css';

// TypeScript interface pro uživatelské informace
interface UserInfo {
  name: string;
  email: string;
  roles: string[];
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  sub?: string;
  acr?: string; // <-- přidáno pro LoA
}

// TypeScript interface pro Keycloak konfiguraci
interface KeycloakConfig {
  url: string;
  realm: string;
  clientId: string;
}

const App: React.FC = () => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [stepUpDone, setStepUpDone] = useState<boolean>(false);

  // Konfigurace pro Keycloak - použije environment variables
  const KEYCLOAK_CONFIG: KeycloakConfig = useMemo(() => ({
    url: process.env.REACT_APP_KEYCLOAK_URL || 'https://your-keycloak-server.com',
    realm: process.env.REACT_APP_KEYCLOAK_REALM || 'your-realm',
    clientId: process.env.REACT_APP_KEYCLOAK_CLIENT_ID || 'your-client-id'
  }), []);

  // Získání user info z UserInfo endpointu (fallback)
  const fetchUserInfo = useCallback(async (accessToken: string): Promise<void> => {
    try {
      const userInfoUrl = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/userinfo`;
      const userInfoResponse = await fetch(userInfoUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      if (!userInfoResponse.ok) {
        throw new Error(`UserInfo request failed: ${userInfoResponse.status} ${userInfoResponse.statusText}`);
      }
      const userData = await userInfoResponse.json();
      setIsAuthenticated(true);
      setUserInfo({
        name: userData.name || `${userData.given_name || ''} ${userData.family_name || ''}`.trim() || userData.preferred_username || 'Neznámý uživatel',
        email: userData.email || 'N/A',
        preferred_username: userData.preferred_username || 'N/A',
        given_name: userData.given_name || 'N/A',
        family_name: userData.family_name || 'N/A',
        sub: userData.sub || 'N/A',
        roles: userData.realm_access?.roles || userData.groups || [],
        acr: userData.acr || 'N/A'
      });
      localStorage.setItem('user_info', JSON.stringify({
        name: userData.name || `${userData.given_name || ''} ${userData.family_name || ''}`.trim() || userData.preferred_username || 'Neznámý uživatel',
        email: userData.email || 'N/A',
        preferred_username: userData.preferred_username || 'N/A',
        given_name: userData.given_name || 'N/A',
        family_name: userData.family_name || 'N/A',
        sub: userData.sub || 'N/A',
        roles: userData.realm_access?.roles || userData.groups || [],
        acr: userData.acr || 'N/A'
      }));
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
          roles: ['user'],
          acr: 'N/A'
        });
        window.history.replaceState({}, document.title, window.location.pathname);
        setLoading(false);
        return;
      }
      alert(`Chyba při získávání informací o uživateli: ${errorMessage}`);
      setLoading(false);
    }
  }, [KEYCLOAK_CONFIG]);

  // Parsování user info z ID tokenu
  const parseUserInfoFromIdToken = useCallback((idToken: string): void => {
    try {
      const tokenParts = idToken.split('.');
      if (tokenParts.length !== 3) {
        throw new Error('Neplatný ID token formát');
      }
      const payload = JSON.parse(atob(tokenParts[1]));
      setIsAuthenticated(true);
      setUserInfo({
        name: payload.name || `${payload.given_name || ''} ${payload.family_name || ''}`.trim() || payload.preferred_username || 'Neznámý uživatel',
        email: payload.email || 'N/A',
        preferred_username: payload.preferred_username || 'N/A',
        given_name: payload.given_name || 'N/A',
        family_name: payload.family_name || 'N/A',
        sub: payload.sub || 'N/A',
        roles: payload.realm_access?.roles || payload.groups || payload.roles || [],
        acr: payload.acr || 'N/A'
      });
      localStorage.setItem('user_info', JSON.stringify({
        name: payload.name || `${payload.given_name || ''} ${payload.family_name || ''}`.trim() || payload.preferred_username || 'Neznámý uživatel',
        email: payload.email || 'N/A',
        preferred_username: payload.preferred_username || 'N/A',
        given_name: payload.given_name || 'N/A',
        family_name: payload.family_name || 'N/A',
        sub: payload.sub || 'N/A',
        roles: payload.realm_access?.roles || payload.groups || payload.roles || [],
        acr: payload.acr || 'N/A'
      }));
      window.history.replaceState({}, document.title, window.location.pathname);
      localStorage.removeItem('used_auth_code');
      setLoading(false);
    } catch (error) {
      const accessToken = localStorage.getItem('access_token');
      if (accessToken) {
        fetchUserInfo(accessToken);
      } else {
        setLoading(false);
      }
    }
  }, [fetchUserInfo]);

  // Výměna code za token
  const exchangeCodeForToken = useCallback(async (code: string): Promise<void> => {
    try {
      const tokenUrl = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/token`;
      const redirectUri = window.location.origin;
      const requestBody = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: KEYCLOAK_CONFIG.clientId,
        code: code,
        redirect_uri: redirectUri
      });
      const tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: requestBody
      });
      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.json();
        throw new Error(`Token request failed: ${tokenResponse.status} ${errorData.error}: ${errorData.error_description}`);
      }
      const tokens = await tokenResponse.json();
      localStorage.setItem('access_token', tokens.access_token);
      if (tokens.id_token) localStorage.setItem('id_token', tokens.id_token);
      if (tokens.refresh_token) localStorage.setItem('refresh_token', tokens.refresh_token);
      if (tokens.id_token) {
        parseUserInfoFromIdToken(tokens.id_token);
      } else {
        await fetchUserInfo(tokens.access_token);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Neznámá chyba';
      alert(`Chyba při dokončování přihlášení: ${errorMessage}`);
      setLoading(false);
    }
  }, [KEYCLOAK_CONFIG, parseUserInfoFromIdToken, fetchUserInfo]);

  // Zpracování návratu z Keycloak
  const parseKeycloakCallback = useCallback((): void => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const error = urlParams.get('error');
    if (error) {
      alert(`Chyba při přihlášení: ${error}`);
      setLoading(false);
      return;
    }
    if (code) {
      const usedCode = localStorage.getItem('used_auth_code');
      if (usedCode === code) {
        setLoading(false);
        return;
      }
      localStorage.setItem('used_auth_code', code);
      exchangeCodeForToken(code);
      return;
    }
    setLoading(false);
  }, [exchangeCodeForToken]);

  const checkAuthStatus = useCallback((): void => {
    const token = localStorage.getItem('access_token');
    if (token) {
      const storedUserInfo = localStorage.getItem('user_info');
      if (storedUserInfo) {
        try {
          const parsedUserInfo = JSON.parse(storedUserInfo);
          setUserInfo(parsedUserInfo);
          setIsAuthenticated(true);
          setLoading(false);
        } catch (error) {
          fetchUserInfo(token);
        }
      } else {
        fetchUserInfo(token);
      }
    } else {
      setLoading(false);
    }
  }, [fetchUserInfo]);

  const login = (): void => {
    const redirectUri = window.location.origin;
    const authUrl = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/auth` +
      `?client_id=${KEYCLOAK_CONFIG.clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=openid profile email roles` +
      `&state=${Date.now()}`;
    window.location.href = authUrl;
  };

  const logout = (): void => {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('id_token');
    localStorage.removeItem('user_info');
    localStorage.removeItem('used_auth_code');
    setIsAuthenticated(false);
    setUserInfo(null);
  };

  // Funkce pro step-up autentizaci (vyšší úroveň ověření)
  const stepUpAuth = (): void => {
    const redirectUri = window.location.origin + "?stepup=1";
    const authUrl = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/auth` +
      `?client_id=${KEYCLOAK_CONFIG.clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=openid` +
      `&acr_values=medium` +
      `&state=${Date.now()}`;
    window.location.href = authUrl;
  };

  // Debug funkce pro smazání všech dat
  const clearAllData = (): void => {
    localStorage.clear();
    sessionStorage.clear();
    window.location.reload();
  };

  // useEffect pro inicializaci aplikace při načtení
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const hasCallbackParams = urlParams.has('code') || urlParams.has('error');
    if (hasCallbackParams) {
      parseKeycloakCallback();
    } else {
      checkAuthStatus();
    }
  }, [parseKeycloakCallback, checkAuthStatus]);

  // Po návratu z Keycloaku zjisti, zda šlo o step-up
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("stepup") === "1") {
      setStepUpDone(true);
    }
  }, [isAuthenticated]);

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner"></div>
        <p>Načítám...</p>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="navbar">
        <div className="nav-content">
          <div className="nav-left">
            <h1>OIDC Demo App</h1>
            {process.env.NODE_ENV === 'development' && (
              <span className="demo-badge">Demo Mode</span>
            )}
          </div>
          <div className="nav-right">
            {isAuthenticated ? (
              <>
                <span className="user-greeting">Vítej, {userInfo?.name}</span>
                <button onClick={logout} className="btn btn-danger">
                  Odhlásit se
                </button>
              </>
            ) : (
              <button onClick={login} className="btn btn-primary">
                Přihlásit se
              </button>
            )}
          </div>
        </div>
      </nav>

      <main className="main-content">
        {!isAuthenticated ? (
          <div className="login-container">
            <div className="login-card">
              <h2>Přihlášení vyžadováno</h2>
              <p>Pro přístup do aplikace se musíte přihlásit pomocí SkodaIDP OIDC.</p>
              {process.env.NODE_ENV === 'development' && (
                <div className="debug-info">
                  <h4>Debug informace:</h4>
                  <div><strong>SkodaIDP URL:</strong> {KEYCLOAK_CONFIG.url}</div>
                  <div><strong>Realm:</strong> {KEYCLOAK_CONFIG.realm}</div>
                  <div><strong>Client ID:</strong> {KEYCLOAK_CONFIG.clientId}</div>
                  <div><strong>Scope:</strong> openid profile email roles</div>
                  <div><strong>Response Type:</strong> code (Authorization Code Flow)</div>
                </div>
              )}
              <button onClick={login} className="btn btn-primary btn-large">
                🔐 Přihlásit přes SkodaIDP
              </button>
              {process.env.NODE_ENV === 'development' && (
                <button 
                  onClick={clearAllData} 
                  className="btn btn-danger"
                  style={{marginTop: '16px', fontSize: '14px'}}
                >
                  🧹 Smazat všechna data (debug)
                </button>
              )}
            </div>
          </div>
        ) : stepUpDone ? (
          <div className="dashboard">
            <div className="card success-card">
              <h2>✅ Jste autentizováni druhým faktorem!</h2>
              <p>Vaše aktuální úroveň ověření (acr): <code>{userInfo?.acr || 'N/A'}</code></p>
              <button onClick={() => setStepUpDone(false)} className="btn btn-secondary" style={{marginTop: '16px'}}>
                Zpět do aplikace
              </button>
            </div>
          </div>
        ) : (
          <div className="dashboard">
            <div className="card success-card">
              <h2>🎉 JSTE ÚSPĚŠNĚ PŘIHLÁŠENI!</h2>
              <p>Vítejte v aplikaci! Přihlášení proběhlo úspěšně pomocí SkodaIDP OIDC.</p>
              <button onClick={stepUpAuth} className="btn btn-warning" style={{marginTop: '16px'}}>
                🔒 Vyžádat vyšší úroveň ověření (step-up)
              </button>
              <div className="user-info">
                <h3>Vaše informace:</h3>
                <div><strong>Celé jméno:</strong> {userInfo?.name}</div>
                <div><strong>Username:</strong> {userInfo?.preferred_username}</div>
                <div><strong>Email:</strong> {userInfo?.email}</div>
                <div><strong>Role:</strong> {userInfo?.roles?.join(', ')}</div>
                <div><strong>User ID:</strong> <code>{userInfo?.sub || 'N/A'}</code></div>
                <div><strong>Aktuální LoA (acr):</strong> <code>{userInfo?.acr || 'N/A'}</code></div>
                <div><strong>Stav:</strong> <span className="status-active">✅ Aktivní relace</span></div>
              </div>
            </div>
            <div className="card">
              <h3>🔐 Informace o přihlášení</h3>
              <p>Detaily o vaší aktuální OIDC relaci:</p>
              <div className="auth-details">
                <div>✅ Autentizace: OIDC/OAuth 2.0</div>
                <div>✅ Poskytovatel: SkodaIDP ({KEYCLOAK_CONFIG.url})</div>
                <div>✅ Realm: {KEYCLOAK_CONFIG.realm}</div>
                <div>✅ Zabezpečení: SSL/TLS</div>
                <div>✅ Session: Aktivní</div>
                <div>✅ Token Type: Bearer</div>
                <div>✅ Scope: openid profile email roles</div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;