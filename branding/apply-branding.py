#!/usr/bin/env python3
"""Apply the Anands Notes branding to a clean Joplin Server checkout.

Usage: apply-branding.py <joplin-root> <overlay-dir>

1. Copies the overlay (theme CSS, logos, icons) over packages/server.
2. Makes a handful of small, exact-match text edits to templates/config.
Every edit must match exactly once, so the build fails loudly if upstream changes.
"""
import shutil, sys
from pathlib import Path

root, overlay = Path(sys.argv[1]), Path(sys.argv[2])
srv = root / 'packages' / 'server'

# 1. overlay files
shutil.copytree(overlay / 'packages' / 'server', srv, dirs_exist_ok=True)

# 2. text edits
def edit(rel, old, new):
    p = srv / rel
    s = p.read_text()
    if s.count(old) != 1:
        sys.exit(f'apply-branding: expected exactly one match in {rel}: {old[:60]!r} (found {s.count(old)})')
    p.write_text(s.replace(old, new))

CSS = '<link rel="stylesheet" href="{{{global.baseUrl}}}/css/main.css" crossorigin="anonymous">'
for layout in ('default', 'basic'):
    edit(f'src/views/layouts/{layout}.mustache', CSS,
         CSS + '\n\t<link rel="stylesheet" href="{{{global.baseUrl}}}/css/anands-theme.css" crossorigin="anonymous">')

edit('src/env.ts', "APP_NAME: 'Joplin Server',", "APP_NAME: 'Anands Notes',")

edit('src/views/partials/navbar.mustache',
     '\t\t\t\t\t{{^global.owner}}\n\t\t\t\t\t\t<span class="navbar-appname">{{global.appName}}</span>\n\t\t\t\t\t{{/global.owner}}',
     '\t\t\t\t\t<span class="navbar-appname">{{global.appName}}</span>')

edit('src/views/index/login.mustache', '<section class="section login-box">\n',
     '<section class="section login-box">\n\t<img class="brand-mark" src="{{{global.baseUrl}}}/images/anands_logo_orange.png" alt="{{global.appName}}"/>\n')
edit('src/views/index/login.mustache', 'Please enter your details to log in to {{global.appName}}', 'Sign in to access your notes')

edit('src/views/partials/footer.mustache',
     '{{global.appName}} {{global.fullVersionString}}, copyright &copy; 2021-{{global.fullYear}} JOPLIN.',
     '{{global.appName}} &middot; powered by Joplin Server {{global.fullVersionString}} &middot; &copy; {{global.fullYear}} Anands.')

# home page: drop the social feeds block and the business promo
home = srv / 'src/views/index/home.mustache'
s = home.read_text()
marker = '<h2 class="title">Follow us on social media</h2>'
promo = '{{> joplinServerBusinessPromo}}\n\n'
if s.count(marker) != 1 or s.count(promo) != 1:
    sys.exit('apply-branding: home.mustache no longer matches')
home.write_text(s[:s.index(marker)].rstrip().replace(promo, '') + '\n')

# published-note page (banner defaults + logo)
edit('src/utils/banners.ts', "background_color: '#ffffff',", "background_color: '#111111',")
edit('src/utils/banners.ts', "text_color: '#4a4a4a',", "text_color: '#1b1b1b',")
edit('src/utils/banners.ts', "logo_title: 'Joplin',", "logo_title: 'Anands Notes',")
edit('src/utils/banners.ts', "logo_url: config().joplinAppBaseUrl,", "logo_url: config().baseUrl,")
edit('src/utils/joplinUtils.ts', '`${baseUrl_}/images/JoplinLogo.png`', '`${baseUrl_}/images/anands_logo_orange.png`')

print('Anands Notes branding applied.')
