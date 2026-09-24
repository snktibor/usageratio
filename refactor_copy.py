import re

with open("components/token-copy-button.tsx", "r", encoding="utf-8") as f:
    content = f.read()

if 'import { useTranslations }' not in content:
    content = content.replace('import { useEffect', 'import { useTranslations } from "next-intl";\nimport { useEffect')

content = re.sub(r'(export function TokenCopyButton\([^)]+\)\s*\{)', r'\1\n  const t = useTranslations("Settings");', content)

strings_to_replace = [
    (r'"A másolás nem sikerült. Próbáld újra."', 't("copy_failed")'),
    (r'>\s*Token a vágólapon\s*<', '>{t("token_on_clipboard")}<'),
    (r'>\s*Másolás…\s*<', '>{t("copying")}<'),
    (r'>\s*Token másolása\s*<', '>{t("copy_token")}<'),
    (r'>\s*A lekérés az auditnaplóba kerül.\s*<', '>{t("audit_notice")}<'),
    (r'>\s*A token a vágólapon.\s*<', '>{t("token_on_clipboard_hidden")}<'),
    (r'" A dashboard Beállítások paneljén adhatod meg."', 't("provide_in_settings")'),
]

for pattern, replacement in strings_to_replace:
    content = re.sub(pattern, replacement, content)

# special handling for {state.phase === "busy" ? "Másolás…" : "Token másolása"}
content = content.replace('state.phase === "busy" ? "Másolás…" : "Token másolása"', 'state.phase === "busy" ? t("copying") : t("copy_token")')

with open("components/token-copy-button.tsx", "w", encoding="utf-8") as f:
    f.write(content)
