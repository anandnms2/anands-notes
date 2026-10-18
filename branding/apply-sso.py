#!/usr/bin/env python3
"""Add OpenID Connect SSO to a (branded) Joplin Server checkout.

Usage: apply-sso.py <joplin-root> <sso-dir>
Run after apply-branding.py. Every edit must match exactly once.
"""
import shutil, sys
from pathlib import Path

root, sso_dir = Path(sys.argv[1]), Path(sys.argv[2])
srv = root / 'packages' / 'server'

def edit(rel, old, new):
    p = srv / rel
    s = p.read_text()
    if s.count(old) != 1:
        sys.exit(f'apply-sso: expected exactly one match in {rel}: {old[:70]!r} (found {s.count(old)})')
    p.write_text(s.replace(old, new))

# 1. the OIDC module
shutil.copy(sso_dir / 'sso.ts', srv / 'src/routes/index/sso.ts')

# 2. register the /sso routes
edit('src/routes/routes.ts', "import indexLogout from './index/logout';",
     "import indexLogout from './index/logout';\nimport indexSso from './index/sso';")
edit('src/routes/routes.ts', "\t'logout': indexLogout,", "\t'logout': indexLogout,\n\t'sso': indexSso,")

# 3. configuration (env vars)
edit('src/env.ts', "\tSAML_ORGANIZATION_DISPLAY_NAME: '', // The name of the organization to display on the login screen. Optional.",
     "\tSAML_ORGANIZATION_DISPLAY_NAME: '', // The name of the organization to display on the login screen. Optional.\n"
     "\n\t// OpenID Connect SSO (Anands Notes). E-mail login keeps working alongside it.\n"
     "\tOIDC_ENABLED: false,\n"
     "\tOIDC_ISSUER_URL: '', // e.g. https://auth.example.com/application/o/notes/\n"
     "\tOIDC_CLIENT_ID: '',\n"
     "\tOIDC_CLIENT_SECRET: '',\n"
     "\tOIDC_REDIRECT_URI: '', // Defaults to <APP_BASE_URL>/sso/callback\n"
     "\tOIDC_SCOPES: 'openid email profile',\n"
     "\tOIDC_BUTTON_LABEL: 'Sign in with SSO',\n"
     "\tOIDC_AUTO_CREATE_USERS: false, // Create an account on first SSO login when no user has the e-mail")
edit('src/env.ts', "\tSAML_ORGANIZATION_DISPLAY_NAME: string;",
     "\tSAML_ORGANIZATION_DISPLAY_NAME: string;\n"
     "\tOIDC_ENABLED: boolean;\n\tOIDC_ISSUER_URL: string;\n\tOIDC_CLIENT_ID: string;\n\tOIDC_CLIENT_SECRET: string;\n"
     "\tOIDC_REDIRECT_URI: string;\n\tOIDC_SCOPES: string;\n\tOIDC_BUTTON_LABEL: string;\n\tOIDC_AUTO_CREATE_USERS: boolean;")

# 4. login page: SSO button (only shown when SSO is configured)
edit('src/routes/index/login.ts', "\t\tsamlEnabled: config().saml.enabled,",
     "\t\tsamlEnabled: config().saml.enabled,\n"
     "\t\toidcEnabled: !!(config().OIDC_ENABLED && config().OIDC_ISSUER_URL && config().OIDC_CLIENT_ID),\n"
     "\t\toidcButtonLabel: config().OIDC_BUTTON_LABEL,")
edit('src/views/index/login.mustache', "\t{{#samlEnabled}}",
     "\t{{#oidcEnabled}}\n"
     "\t\t<div class=\"sso-divider\"><span>or</span></div>\n"
     "\t\t<a class=\"button sso-button\" href=\"{{{global.baseUrl}}}/sso/login{{#applicationAuthId}}?application_auth_id={{applicationAuthId}}{{/applicationAuthId}}\">{{oidcButtonLabel}}</a>\n"
     "\t{{/oidcEnabled}}\n\n"
     "\t{{#samlEnabled}}")

print('Anands Notes SSO (OpenID Connect) applied.')
