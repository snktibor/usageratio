import re
import json
import os

with open("components/settings-dialog.tsx", "r", encoding="utf-8") as f:
    content = f.read()

# Add useTranslations import
if 'import { useTranslations }' not in content:
    content = content.replace('import { useEffect', 'import { useTranslations } from "next-intl";\nimport { useEffect')

# Replace text
strings_to_replace = [
    (r'>\s*Csoportok\s*<', '>{t("groups")}<'),
    (r'"Új csoport neve, például Work"', 't("new_group_placeholder")'),
    (r'>\s*Hozzáadás\s*<', '>{t("add")}<'),
    (r'>\s*Mégse\s*<', '>{t("cancel")}<'),
    (r'saving \? "Mentés…" : "Mentés"', 'saving ? t("saving") : t("save")'),
    (r'>\s*Beállítások\s*<', '>{t("settings_title")}<'),
    (r'"Van tárolt jelentése, ezért nem törölhető"', 't("group_has_reports_cannot_delete")'),
    (r'title="Törlés"', 'title={t("delete")}'),
    (r'>\s*Beszámít:\s*<', '>{t("counts_towards")}<'),
    (r'>\s*egyik látható fiókba sem\s*<', '>{t("no_visible_account")}<'),
    (r'>\s*Reset\s*<', '>{t("reset")}<'),
    (r'"A csoportnév 1–64 karakter lehet: betű, szám, szóköz, pont, kötőjel és aláhúzás, " \+\n\s*"az elején betűvel vagy számmal."', 't("group_name_rules")'),
    (r'"Legalább egy AI-fióknak látszania kell a dashboardon."', 't("at_least_one_visible_account")'),
    (r'"Add meg a reset időpontját óra:perc formában, például 00:00."', 't("reset_time_format_error")'),
]

for pattern, replacement in strings_to_replace:
    content = re.sub(pattern, replacement, content)

# Inject const t = useTranslations("Settings"); into SettingsForm and SettingsDialog
content = re.sub(r'(export function SettingsForm\([^)]+\)\s*\{)', r'\1\n  const t = useTranslations("Settings");', content)
content = re.sub(r'(export function SettingsDialog\([^)]+\)\s*\{)', r'\1\n  const t = useTranslations("Settings");', content)

with open("components/settings-dialog.tsx", "w", encoding="utf-8") as f:
    f.write(content)
