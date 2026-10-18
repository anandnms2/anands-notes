// Anands Notes - OpenID Connect single sign-on for Joplin Server.
//
//   GET /sso/login     Direct SSO trigger link: redirects straight to the identity provider.
//   GET /sso/callback  OIDC redirect URI: validates the response and logs the user in.
//
// The verified e-mail address is the identity: it is matched against Joplin user e-mails.
// Normal e-mail + password login keeps working alongside this.
//
// No third-party dependencies: authorization code flow with PKCE, ID token signature
// verification (RS256 / ES256 via JWKS, HS256 via client secret) using Node's crypto.

import * as crypto from 'crypto';
import config from '../../config';
import Router from '../../utils/Router';
import { redirect, SubPath } from '../../utils/routeUtils';
import { AppContext, RouteType } from '../../utils/types';
import { cookieSet } from '../../utils/cookies';
import { ErrorBadRequest, ErrorForbidden } from '../../utils/errors';
import { adminDashboardUrl, applicationsConfirmUrl, homeUrl } from '../../utils/urlUtils';
import limiterLoginBruteForce from '../../utils/request/limiterLoginBruteForce';
import { userIp } from '../../utils/requestUtils';

const router = new Router(RouteType.Web);
router.public = true;

const stateCookieName = 'oidc_state';
const httpTimeoutMs = 10000;

interface Discovery {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri?: string;
	userinfo_endpoint?: string;
	token_endpoint_auth_methods_supported?: string[];
}

interface StateData {
	state: string;
	nonce: string;
	verifier: string;
	exp: number;
	appAuthId?: string; // Joplin app browser-authorisation flow, resumed after login
}

const b64url = (buf: Buffer) => buf.toString('base64url');
const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));

const queryValue = (ctx: AppContext, name: string): string => {
	const v = ctx.query?.[name];
	return Array.isArray(v) ? v[0] : (v || '');
};

const assertEnabled = () => {
	const c = config();
	if (!c.OIDC_ENABLED) throw new ErrorForbidden('Single sign-on is not enabled');
	if (!c.OIDC_ISSUER_URL || !c.OIDC_CLIENT_ID || !c.OIDC_CLIENT_SECRET) {
		throw new ErrorForbidden('Single sign-on is not configured (OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)');
	}
};

const redirectUri = () => config().OIDC_REDIRECT_URI || `${config().baseUrl}/sso/callback`;

// -- HTTP helpers ------------------------------------------------------------------------

const fetchJson = async (url: string, init: RequestInit = {}) => {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(httpTimeoutMs) });
	const text = await response.text();
	let json: Record<string, unknown> = null;
	try { json = JSON.parse(text); } catch (_e) { /* handled below */ }
	if (!response.ok || !json) {
		const detail = json && (json.error_description || json.error) ? `: ${json.error_description || json.error}` : '';
		throw new ErrorForbidden(`SSO provider request failed (${response.status})${detail}`);
	}
	return json;
};

let discoveryCache: { url: string; doc: Discovery; at: number } = null;

const getDiscovery = async (): Promise<Discovery> => {
	const base = config().OIDC_ISSUER_URL.replace(/\/+$/, '');
	const url = `${base}/.well-known/openid-configuration`;
	if (discoveryCache && discoveryCache.url === url && Date.now() - discoveryCache.at < 10 * 60 * 1000) return discoveryCache.doc;
	const doc = await fetchJson(url) as unknown as Discovery;
	if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint) throw new ErrorForbidden('Invalid SSO discovery document');
	discoveryCache = { url, doc, at: Date.now() };
	return doc;
};

let jwksCache: { uri: string; keys: crypto.JsonWebKey[]; at: number } = null;

const getJwks = async (uri: string, forceRefresh = false) => {
	if (!forceRefresh && jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.at < 10 * 60 * 1000) return jwksCache.keys;
	const json = await fetchJson(uri) as { keys?: crypto.JsonWebKey[] };
	jwksCache = { uri, keys: json.keys || [], at: Date.now() };
	return jwksCache.keys;
};

// -- State cookie (signed, short lived, SameSite=Lax so it survives the redirect back) ---

const sign = (data: string) => crypto.createHmac('sha256', config().OIDC_CLIENT_SECRET).update(`oidc-state:${data}`).digest('base64url');

const setStateCookie = (ctx: AppContext, data: StateData) => {
	const payload = b64url(Buffer.from(JSON.stringify(data)));
	ctx.cookies.set(stateCookieName, `${payload}.${sign(payload)}`, {
		httpOnly: true,
		secure: config().cookieSecure,
		sameSite: 'lax',
		maxAge: 10 * 60 * 1000,
		overwrite: true,
	});
};

const readStateCookie = (ctx: AppContext): StateData => {
	const raw = ctx.cookies.get(stateCookieName);
	ctx.cookies.set(stateCookieName, '', { httpOnly: true, secure: config().cookieSecure, sameSite: 'lax', maxAge: 0, overwrite: true });
	if (!raw) throw new ErrorBadRequest('SSO session expired or cookies are blocked. Please try again.');
	const [payload, signature] = raw.split('.');
	const expected = sign(payload || '');
	if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
		throw new ErrorBadRequest('Invalid SSO state');
	}
	const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as StateData;
	if (!data.exp || data.exp < Date.now()) throw new ErrorBadRequest('SSO session expired. Please try again.');
	return data;
};

// -- ID token verification ---------------------------------------------------------------

type Claims = Record<string, unknown>;

const verifyIdToken = async (idToken: string, disc: Discovery, nonce: string): Promise<Claims> => {
	const parts = idToken.split('.');
	if (parts.length !== 3) throw new ErrorForbidden('Invalid ID token');
	const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
	const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Claims;
	const data = Buffer.from(`${parts[0]}.${parts[1]}`);
	const signature = Buffer.from(parts[2], 'base64url');

	let valid = false;
	if (header.alg === 'HS256') {
		const expected = crypto.createHmac('sha256', config().OIDC_CLIENT_SECRET).update(data).digest();
		valid = expected.length === signature.length && crypto.timingSafeEqual(expected, signature);
	} else if (header.alg === 'RS256' || header.alg === 'ES256') {
		if (!disc.jwks_uri) throw new ErrorForbidden('SSO provider does not publish signing keys');
		const findKey = (keys: crypto.JsonWebKey[]) => keys.find(k => (!header.kid || (k as { kid?: string }).kid === header.kid) && (k as { use?: string }).use !== 'enc');
		let jwk = findKey(await getJwks(disc.jwks_uri));
		if (!jwk) jwk = findKey(await getJwks(disc.jwks_uri, true)); // key rotation
		if (!jwk) throw new ErrorForbidden('Could not find the ID token signing key');
		const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
		valid = header.alg === 'RS256' ?
			crypto.verify('RSA-SHA256', data, key, signature) :
			crypto.verify('SHA256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
	} else {
		throw new ErrorForbidden(`Unsupported ID token algorithm: ${header.alg}`);
	}
	if (!valid) throw new ErrorForbidden('Invalid ID token signature');

	const now = Math.floor(Date.now() / 1000);
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (claims.iss !== disc.issuer) throw new ErrorForbidden('ID token issuer mismatch');
	if (!aud.includes(config().OIDC_CLIENT_ID)) throw new ErrorForbidden('ID token audience mismatch');
	if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new ErrorForbidden('ID token expired');
	if (claims.nonce !== nonce) throw new ErrorForbidden('ID token nonce mismatch');
	return claims;
};

// -- Routes ------------------------------------------------------------------------------

const startLogin = async (ctx: AppContext) => {
	assertEnabled();
	if (ctx.joplin.owner) return redirect(ctx, ctx.joplin.owner.is_admin ? adminDashboardUrl() : homeUrl());

	const disc = await getDiscovery();
	const verifier = randomToken(48);
	const stateData: StateData = {
		state: randomToken(),
		nonce: randomToken(),
		verifier,
		exp: Date.now() + 10 * 60 * 1000,
	};
	const appAuthId = queryValue(ctx, 'application_auth_id');
	if (/^[A-Za-z0-9_-]{1,64}$/.test(appAuthId)) stateData.appAuthId = appAuthId;
	setStateCookie(ctx, stateData);

	const url = new URL(disc.authorization_endpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', config().OIDC_CLIENT_ID);
	url.searchParams.set('redirect_uri', redirectUri());
	url.searchParams.set('scope', config().OIDC_SCOPES);
	url.searchParams.set('state', stateData.state);
	url.searchParams.set('nonce', stateData.nonce);
	url.searchParams.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest()));
	url.searchParams.set('code_challenge_method', 'S256');
	const hint = queryValue(ctx, 'email');
	if (hint) url.searchParams.set('login_hint', hint);
	return redirect(ctx, url.toString());
};

const finishLogin = async (ctx: AppContext) => {
	assertEnabled();
	await limiterLoginBruteForce(userIp(ctx));

	const providerError = queryValue(ctx, 'error');
	if (providerError) throw new ErrorForbidden(`SSO login failed: ${queryValue(ctx, 'error_description') || providerError}`);

	const code = queryValue(ctx, 'code');
	const stateParam = queryValue(ctx, 'state');
	if (!code || !stateParam) throw new ErrorBadRequest('Missing SSO code or state');

	const saved = readStateCookie(ctx);
	const a = Buffer.from(saved.state);
	const b = Buffer.from(stateParam);
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new ErrorBadRequest('SSO state mismatch');

	const disc = await getDiscovery();

	// Exchange the code for tokens
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri(),
		client_id: config().OIDC_CLIENT_ID,
		code_verifier: saved.verifier,
	});
	const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
	const methods = disc.token_endpoint_auth_methods_supported || [];
	if (methods.includes('client_secret_basic') && !methods.includes('client_secret_post')) {
		headers['Authorization'] = `Basic ${Buffer.from(`${encodeURIComponent(config().OIDC_CLIENT_ID)}:${encodeURIComponent(config().OIDC_CLIENT_SECRET)}`).toString('base64')}`;
	} else {
		body.set('client_secret', config().OIDC_CLIENT_SECRET);
	}
	const tokens = await fetchJson(disc.token_endpoint, { method: 'POST', headers, body: body.toString() }) as { id_token?: string; access_token?: string };
	if (!tokens.id_token) throw new ErrorForbidden('SSO provider did not return an ID token');

	const claims = await verifyIdToken(tokens.id_token, disc, saved.nonce);

	// Email is the identity. Fall back to the userinfo endpoint if the ID token has no email.
	let profile: Claims = claims;
	if (typeof claims.email !== 'string' && disc.userinfo_endpoint && tokens.access_token) {
		const info = await fetchJson(disc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
		if (info.sub !== claims.sub) throw new ErrorForbidden('SSO userinfo subject mismatch');
		profile = { ...claims, ...info };
	}

	if (typeof profile.email !== 'string' || !profile.email.includes('@')) {
		throw new ErrorForbidden('Your SSO account has no e-mail address. Make sure the "email" scope is granted.');
	}
	if (profile.email_verified === false) throw new ErrorForbidden('Your SSO e-mail address is not verified');

	const email = profile.email.trim();
	const userModel = ctx.joplin.models.user();
	let user = await userModel.loadByEmail(email.toLowerCase());
	if (!user && email !== email.toLowerCase()) user = await userModel.loadByEmail(email);

	if (!user) {
		if (!config().OIDC_AUTO_CREATE_USERS) {
			throw noAccountError(email);
		}
		const fullName = [profile.name, profile.preferred_username, email].find(v => typeof v === 'string' && v) as string;
		user = await userModel.save({
			email: email.toLowerCase(),
			full_name: fullName,
			must_set_password: 0,
			email_confirmed: 1,
			is_external: 1,
			password: '',
		}, { skipValidation: true });
	}

	if (user.enabled === 0) throw new ErrorForbidden('This account is disabled');

	const session = await ctx.joplin.models.session().createUserSession(user.id);
	cookieSet(ctx, 'sessionId', session.id);

	const target = saved.appAuthId ? applicationsConfirmUrl(saved.appAuthId) : (user.is_admin ? adminDashboardUrl() : homeUrl());

	// The session cookie is SameSite-restricted, and this request comes from the identity
	// provider (cross-site). So rather than a 302, return a tiny page that navigates from
	// our own origin - the browser then sends the cookie on that same-site navigation.
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="refresh" content="0;url=${target}">
	<title>Signing in...</title>
</head>
<body style="font-family:sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
	<p>Signing you in&hellip; <a style="color:#f68712" href="${target}">Continue</a></p>
	<script>window.location.replace(${JSON.stringify(target)});</script>
</body>
</html>`;
};

const noAccountError = (email: string) => new ErrorForbidden(`No Anands Notes account exists for ${email}. Ask the administrator to create one with this e-mail address.`);

router.get('sso/:id', async (path: SubPath, ctx: AppContext) => {
	if (path.id === 'login') return startLogin(ctx);
	if (path.id === 'callback') return finishLogin(ctx);
	throw new ErrorBadRequest('Unknown SSO endpoint');
});

export default router;
