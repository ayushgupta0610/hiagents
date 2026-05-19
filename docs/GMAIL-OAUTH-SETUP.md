# Gmail OAuth setup (one-time per client)

You set up the OAuth app **once** in your own Google Cloud account. All client deployments use the same OAuth credentials. Each client OAuths through your app to grant their Gmail access.

## 1. Create a Google Cloud project

1. Go to https://console.cloud.google.com/
2. Create a new project (e.g. "inbox-ai").
3. Enable the **Gmail API**: APIs & Services → Library → search "Gmail API" → Enable.

## 2. Configure OAuth consent screen

1. APIs & Services → OAuth consent screen.
2. User Type: **External**.
3. App name: "inbox-ai" (or whatever you want clients to see).
4. User support email + developer contact: your email.
5. **Scopes** → Add the following:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/userinfo.email`
6. **Test users** → add the Gmail addresses of you + first clients (up to 100). They'll be able to OAuth even while the app is unverified.

## 3. Create OAuth client credentials

1. APIs & Services → Credentials → Create Credentials → OAuth client ID.
2. Application type: **Web application**.
3. Authorized redirect URIs: add **every** client's callback URL. For each deployment:
   - `https://bot.<clientdomain>.com/oauth/callback`
4. Save. Copy `Client ID` and `Client secret` into each deployment's `.env`:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`

## 4. Per-client OAuth flow

1. Add the client's Gmail to "Test users" in your consent screen (until you submit for verification).
2. Add their `https://bot.<clientdomain>.com/oauth/callback` to "Authorized redirect URIs".
3. After deploying their stack, have them visit `https://bot.<clientdomain>.com/admin`, log in, and click "Connect Gmail".
4. They'll see a Google warning ("Google hasn't verified this app") because the app is unverified — click **Advanced → Go to inbox-ai (unsafe)**. This is normal for unverified internal apps.
5. They grant the scopes. Refresh token is stored in Supabase `oauth_tokens` table.

## 5. (Later) Submitting for verification

Once you have ~3 clients, submit the app for Google verification to remove the warning screen. ~4-6 week review process. Required materials: privacy policy URL, terms URL, demo video showing data use.
