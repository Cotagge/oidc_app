# CLAUDE.md — oidc_app projekt

## Co je tato aplikace
React SPA (TypeScript, Create React App) pro **demonstraci přihlášení přes Keycloak**.

Uživatel si vybere client ID (1FA/2FA/3FA), každý má nastavenou jinou LOA (1–3). Flow pak vynucuje MFA odpovídající LOA.

## Git branch strategie (Netlify)
Každý branch = samostatné Netlify prostředí:
- `dev` — vývojové prostředí
- `test` — testovací prostředí
- `prod` — produkce
- `main` — hlavní větev (PR target)

Aktuálně pracujeme na branchi **`dev`**.

## Architektura (src/App.tsx)
Jediný soubor — monolitická React komponenta `App.tsx` + styly `App.css`.

### Klíčové stavy
- `isAuthenticated` — je uživatel přihlášen
- `userInfo` — data o uživateli (name, email, acr, amr, ...)
- `usedClientType` — `'1FA' | '2FA' | '3FA' | null`
- `loading` — načítání

### OIDC flow (Authorization Code + PKCE)
1. Uživatel klikne na tlačítko (1FA/2FA/3FA)
2. Vygeneruje se PKCE code_verifier + code_challenge (SHA-256, S256)
3. Redirect na Keycloak auth endpoint s `?client_type=1FA/2FA/3FA` jako redirect_uri parametr
4. Keycloak vrátí `?code=...&client_type=...`
5. Token exchange (POST /token s code_verifier)
6. Parsování ID tokenu nebo fallback na /userinfo endpoint
7. Backchannel logout při odhlášení

### Keycloak konfigurace (env proměnné)
```
REACT_APP_KEYCLOAK_URL
REACT_APP_KEYCLOAK_REALM
REACT_APP_KEYCLOAK_CLIENT_ID_1F
REACT_APP_KEYCLOAK_CLIENT_ID_2F
REACT_APP_KEYCLOAK_CLIENT_ID_3F
REACT_APP_KEYCLOAK_ENV  (zobrazuje se u loga, např. "DEV")
```

### Login parametry
- `prompt=login` + `max_age=0` na 1FA klientovi (vynucení přihlášení)
- scope: `openid profile email microprofile-jwt amr`

## Plánované změny (ROZPRACOVÁNO)
### Přidání rozcestníku OIDC / SAML
**Cíl:** Před výběrem 1FA/2FA/3FA zobrazit rozcestník pro volbu protokolu.

**Nový stav:** `protocol: 'oidc' | 'saml' | null` (null = rozcestník)

**OIDC flow:** beze změny

**SAML flow:**
- Analogické klienty v Keycloaku (SAML SP)
- SP-initiated SSO redirect na Keycloak SAML endpoint
- Nové env proměnné: `REACT_APP_KEYCLOAK_SAML_CLIENT_ID_1F/2F/3F`
- Keycloak SAML endpoint: `{url}/realms/{realm}/protocol/saml`

**Stav:** Čeká na odpověď ohledně SAML flow detailů (SP přímo vs. IdP proxy).

## Styl kódu
- Vše v jednom `App.tsx` souboru (nerozděláváme na komponenty pokud to není nutné)
- Komentáře v češtině
- `useCallback` + `useMemo` pro memoizaci
- `localStorage` pro persistenci tokenů a user info
- Komunikace s uživatelem: česky
