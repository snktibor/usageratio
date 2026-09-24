import re

with open("components/api-token-settings.tsx", "r", encoding="utf-8") as f:
    content = f.read()

if 'import { useTranslations }' not in content:
    content = content.replace('import { useEffect', 'import { useTranslations } from "next-intl";\nimport { useEffect')

content = re.sub(r'(export function ApiTokenSettings\([^)]+\)\s*\{)', r'\1\n  const t = useTranslations("Settings");', content)
content = re.sub(r'(export function AuditDialog\([^)]+\)\s*\{)', r'\1\n  const t = useTranslations("Settings");', content)
content = re.sub(r'(export function ConfirmReplaceDialog\([^)]+\)\s*\{)', r'\1\n  const t = useTranslations("Settings");', content)

strings_to_replace = [
    (r'"A token elmentve."', 't("token_saved")'),
    (r'"A token módosítva."', 't("token_modified")'),
    (r'"A munkamenet lejárt. Lépj be újra a PIN-kóddal, utána mentsd újra a tokent."', 't("session_expired")'),
    (r'"A szerver elutasította a tokent: 16–512 szóköz nélküli ASCII karakter lehet."', 't("token_rejected")'),
    (r'"A mentés nem sikerült, az adattár most nem érhető el. Próbáld újra kicsit később."', 't("store_unavailable")'),
    (r'"A mentés nem sikerült: a szerver nem válaszolt. Ellenőrizd a kapcsolatot, és próbáld újra."', 't("server_did_not_respond")'),
    (r'"Állapot betöltése…"', 't("loading_status")'),
    (r'>\s*Új token a régi helyére\s*<', '>{t("new_token_placeholder")}<'),
    (r'"A szerver USAGE_API_TOKEN-je"', 't("server_token_placeholder")'),
    (r'saving \? "Mentés…" : hasStored \? "Token módosítása" : "Token hozzáadása"', 'saving ? t("saving") : hasStored ? t("modify_token") : t("add_token")'),
]

for pattern, replacement in strings_to_replace:
    content = re.sub(pattern, replacement, content)

with open("components/api-token-settings.tsx", "w", encoding="utf-8") as f:
    f.write(content)
