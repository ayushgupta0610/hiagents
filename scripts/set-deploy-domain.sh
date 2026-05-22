#!/usr/bin/env bash
# scripts/set-deploy-domain.sh
#
# Swap the canonical deployment domain across every doc + example config
# in the repo. Runtime config (BASE_URL, DOMAIN, GOOGLE_REDIRECT_URI) is
# already env-driven via .env, so this script only touches static examples
# and operator-facing documentation — your live VPS keeps reading its own
# .env values.
#
# Usage:
#   scripts/set-deploy-domain.sh bot.aiagencycorp.com
#   scripts/set-deploy-domain.sh app.hiagents.digital
#
# The argument is the canonical singleton hostname, written as
# "<prefix>.<apex-domain>". The script splits at the first dot:
#   bot.aiagencycorp.com  →  prefix=bot, apex=aiagencycorp.com
#   app.hiagents.digital  →  prefix=app, apex=hiagents.digital
#
# It then swaps three patterns at once across the doc set:
#   1. singleton hostname        e.g.  bot.aiagencycorp.com
#   2. multi-client dash form    e.g.  bot-acme.aiagencycorp.com
#   3. multi-client placeholder  e.g.  bot.<client-slug>.aiagencycorp.com
#
# Files it edits:
#   - .env.example                       (BASE_URL / DOMAIN / GOOGLE_REDIRECT_URI defaults)
#   - README.md                          (quick-start URL examples)
#   - docs/DEPLOY.md                     (every hostname mention)
#   - docs/GMAIL-OAUTH-SETUP.md          (OAuth redirect URI examples)
#   - docs/nginx-vhost.conf.example      (server_name + certbot command)
#   - .deploy-domain                     (single-line marker = current value)
#
# Files it does NOT edit:
#   - .env / .env.local / .env.production   (your real runtime config)
#   - src/**                                 (no hardcoded hostnames there)
#   - marketing/**                           (separate canonical brand text)
#   - docs/superpowers/**                    (historical plan snapshots)
#
# Idempotent: rerunning with the same value is a no-op. Rerunning with a
# new value swaps from whatever is currently in .deploy-domain (and
# additionally scrubs the two well-known historical hostnames so a stale
# repo can be brought current in one shot).

set -euo pipefail

NEW="${1:-}"
if [[ -z "$NEW" ]]; then
  echo "Usage: $0 <new-deploy-domain>" >&2
  echo "Example: $0 bot.aiagencycorp.com" >&2
  exit 1
fi

if [[ ! "$NEW" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "ERROR: '$NEW' doesn't look like a hostname (lowercase, no scheme/path/trailing-dot)" >&2
  exit 1
fi

NEW_PREFIX="${NEW%%.*}"      # bot
NEW_APEX="${NEW#*.}"         # aiagencycorp.com

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

MARKER="$REPO_ROOT/.deploy-domain"
OLD=""
if [[ -f "$MARKER" ]]; then
  OLD="$(tr -d '[:space:]' < "$MARKER")"
fi

if [[ "$OLD" == "$NEW" ]]; then
  echo "Deploy domain is already $NEW — nothing to do."
  exit 0
fi

echo "Setting deploy domain → $NEW  (prefix=$NEW_PREFIX, apex=$NEW_APEX)"
[[ -n "$OLD" ]] && echo "  (was: $OLD)"

# Files to touch. The nginx config file historically lived under two
# different names; pick whichever is present.
FILES=(
  .env.example
  README.md
  docs/DEPLOY.md
  docs/GMAIL-OAUTH-SETUP.md
)
for nginx_candidate in docs/nginx-vhost.conf.example docs/nginx-hiagents.conf.example docs/nginx-inbox-ai.conf.example; do
  if [[ -f "$nginx_candidate" ]]; then
    FILES+=("$nginx_candidate")
    break
  fi
done

# Build sed expression list. For each historical hostname (the current
# recorded one plus the two known forks), generate the three swap patterns
# in this exact order — most specific first, since sed runs them in order
# on each line:
#   1. <prefix>-X.<apex>           multi-client dash form (X = any safe char)
#   2. <prefix>.<X>.<apex>         multi-client placeholder form
#   3. <prefix>.<apex>             singleton
#
# We also handle the case of the `<client-slug>` and similar < > placeholders
# explicitly — sed's BRE doesn't capture those across the `.` separator
# cleanly, so we list both variants of the multi-client pattern.

CANDIDATES=()
[[ -n "$OLD" ]] && CANDIDATES+=("$OLD")
for fb in bot.aiagencycorp.com app.hiagents.digital; do
  [[ "$fb" != "$NEW" ]] && CANDIDATES+=("$fb")
done

# Deduplicate while preserving order
SEEN=""
UNIQUE_CANDIDATES=()
for c in "${CANDIDATES[@]}"; do
  case " $SEEN " in
    *" $c "*) ;;
    *) UNIQUE_CANDIDATES+=("$c"); SEEN="$SEEN $c" ;;
  esac
done

SED_EXPRS=()
for old in "${UNIQUE_CANDIDATES[@]}"; do
  old_prefix="${old%%.*}"
  old_apex="${old#*.}"
  # Skip if old == new for this fork
  if [[ "$old_prefix" == "$NEW_PREFIX" ]] && [[ "$old_apex" == "$NEW_APEX" ]]; then
    continue
  fi
  # Pattern 1: <prefix>-X.<apex>  (multi-client dash form; X is alnum + hyphen)
  SED_EXPRS+=("-e" "s|${old_prefix}-\\([a-z0-9-]\\{1,\\}\\)\\.${old_apex}|${NEW_PREFIX}-\\1.${NEW_APEX}|g")
  # Pattern 2: <prefix>.<X>.<apex>  (multi-client angle-bracket placeholder)
  SED_EXPRS+=("-e" "s|${old_prefix}\\.<\\([^>]*\\)>\\.${old_apex}|${NEW_PREFIX}.<\\1>.${NEW_APEX}|g")
  # Pattern 3: <prefix>.<apex>  (singleton)
  SED_EXPRS+=("-e" "s|${old_prefix}\\.${old_apex}|${NEW_PREFIX}.${NEW_APEX}|g")
done

if [[ ${#SED_EXPRS[@]} -eq 0 ]]; then
  echo "Nothing to swap (no old → new mapping). Updating marker only."
fi

for f in "${FILES[@]}"; do
  if [[ -f "$f" ]]; then
    if [[ ${#SED_EXPRS[@]} -gt 0 ]]; then
      # GNU/BSD sed both honour `-i.bak`; clean up the backup right after.
      sed -i.bak "${SED_EXPRS[@]}" "$f"
      rm -f "$f.bak"
    fi
    echo "  updated $f"
  else
    echo "  skipped $f (not present)"
  fi
done

# Update / create the marker so the next run knows what to swap *from*.
echo "$NEW" > "$MARKER"
echo "  wrote $MARKER"

echo
echo "Done. Review with:  git diff"
echo
echo "Don't forget to update your runtime env on the VPS:"
echo "  - .env / .env.local: BASE_URL=https://$NEW   DOMAIN=$NEW   GOOGLE_REDIRECT_URI=https://$NEW/oauth/callback"
echo "  - Google Cloud Console → OAuth client → Authorized redirect URIs: add https://$NEW/oauth/callback"
echo "  - DNS A record for $NEW → your VPS IP"
echo "  - nginx vhost server_name and certbot --nginx -d $NEW"
