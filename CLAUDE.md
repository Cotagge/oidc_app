# CLAUDE.md — SIP Demo App projekt

## Co je tato aplikace
React SPA (TypeScript, Create React App) pro **demonstraci přihlášení přes Keycloak** (SIP Demo App).

Uživatel projde tří-krokovým rozcestníkem (DEV/TEST/PROD → OIDC/SAML → 1FA/2FA/3FA), kde každý FA klient má jinou LOA (1–3) a flow vynucuje odpovídající MFA.

Vzhled je postavený na knihovně **`@skodaflow/web-library`** (Škoda Flow Design System na bázi MUI).

## Git branch strategie (Netlify)
**Jedna Netlify URL pro všechna prostředí.** Příklad: `sip-login.netlify.app`. Volba prostředí Keycloaku je v UI a načítá se z runtime configu, ne z env proměnných.

- `main` — hlavní větev, deployuje se na produkční Netlify URL.
- `dev` — vývojová větev pro testování změn samotné appky před mergem do `main`.

Žádné samostatné `test`/`prod` Netlify prostředí.

## Runtime konfigurace
Soubor `public/config.json` se fetchuje při startu (`fetch('/config.json')`). Obsahuje sekci `environments` s klíči (např. `DEV`, `TEST`, `PROD`), kde každé prostředí má:
- `label` — zobrazovaný název v UI (chip v headeru)
- `url` — Keycloak base URL
- `realm` — Keycloak realm
- `oidcClient1F/2F/3F` — OIDC client IDs
- `samlClient1F/2F/3F` — SAML client IDs

**Výhoda:** jeden build slouží všem prostředím; změna konfigurace = úprava JSONu v Netlify deployi, není potřeba rebuild.

Zvolené prostředí se persistuje v `localStorage` pod klíčem `sip_demo_env`.

## Architektura (src/App.tsx)
Jediný soubor — monolitická React komponenta `App.tsx` + minimální `App.css` (jen `body` reset a `code` styl).

### Klíčové stavy
- `config` — načtený `AppConfig` z `config.json`
- `selectedEnv` — klíč prostředí (`'DEV'`/`'TEST'`/`'PROD'`)
- `protocol` — `'oidc' | 'saml' | null`
- `usedClientType` — `'1FA' | '2FA' | '3FA' | null`
- `isAuthenticated`, `userInfo`, `samlAttributes`, `samlRawXml`
- `errorMsg` — zobrazí se ve `Banner` komponentě (Škoda variant `error`)

### Stage flow (rozcestník)
`stage` se odvozuje: `!selectedEnv → 'env'`, `!protocol → 'protocol'`, jinak `'clientType'`. Každý krok rendruje `SelectionCard` MUI karty.

### OIDC flow (Authorization Code + PKCE)
Beze změny logiky — viz `loginWithOidc`, `exchangeCodeForToken`, `parseUserInfoFromIdToken`. Endpointy a client ID se berou z aktivního `envConfig`, ne z env proměnných.

### SAML flow
Beze změny logiky — viz `loginWithSaml`, `parseSamlCallback`. Endpointy z `envConfig`.

### Logout flow
Aplikace nabízí dvě varianty (obě jsou tlačítka v dashboardu po loginu):

1. **`logoutLocal()` — Odhlásit z aplikace**
   - Vyčistí `localStorage` (kromě `sip_demo_env`) + `sessionStorage` a resetuje React stav.
   - **Keycloak SSO cookie zůstává** — další login projde bez hesla (kromě 1FA s `prompt=login`).

2. **`logoutSSO()` — Odhlásit ze SSO (IdP)** = pravý Single Logout
   - **OIDC**: redirect na `/protocol/openid-connect/logout` s `id_token_hint`, `post_logout_redirect_uri` a `client_id` (RP-Initiated Logout 1.0).
   - **SAML**: redirect s `<samlp:LogoutRequest>` (deflate + base64) na `/protocol/saml`. NameID se bere z `userInfo.sub`.
   - Před redirectem vyčistí storage a stav.

**Vyžaduje konfiguraci Keycloaku:**
- OIDC klienti: *Valid post logout redirect URIs* = origin appky.
- SAML klienti: *Logout Service Redirect Binding URL* = origin appky; ověřit kompatibilitu NameID formátu.

## UI komponenty
- `SkodaThemeProvider globalBaseline` — wrap celé appky.
- `PageLayout` (Škoda) — strukturuje header + obsah + footer.
- `Header` + `HeaderLogo` — top bar, jen logo (clickable → reset prostředí) + chip s názvem prostředí.
- `Footer` (Škoda) — minimální copyright + info o aktivním prostředí.
- `Banner` (Škoda) `variant="error"` — chybové hlášky místo `alert()`.
- MUI `Card`/`CardActionArea` — karty pro výběr v rozcestníku (`SelectionCard` lokální helper).
- MUI `Accordion` — debug informace v dev módu, raw SAML XML viewer.
- MUI `Chip` — odznaky prostředí, protokolu, FA úrovně.

## Styl kódu
- Vše v jednom `App.tsx` souboru (nerozdělujeme na komponenty pokud to není nutné — jediná výjimka jsou lokální `SelectionCard` a `InfoRow` helpery).
- Komentáře v češtině, pull request texty / commit messages v angličtině.
- `useCallback` + `useMemo` pro memoizaci.
- `localStorage` pro persistenci tokenů, user info a zvoleného env.
- Komunikace s uživatelem: česky.
- Žádné `alert()` voláni — chybové stavy přes `errorMsg` a `Banner`.
