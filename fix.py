import re

with open("components/settings-dialog.tsx", "r", encoding="utf-8") as f:
    content = f.read()

# Add imports
content = content.replace('import { useEffect', 'import { useTranslations } from "next-intl";\nimport { useEffect')

# Inject t in components
content = content.replace('export function SettingsForm({ view, titleId, onClose }: { view: SettingsView; titleId: string; onClose: () => void }) {', 
                          'export function SettingsForm({ view, titleId, onClose }: { view: SettingsView; titleId: string; onClose: () => void }) {\n  const t = useTranslations("Settings");')
content = content.replace('export function SettingsDialog({ view }: { view: SettingsView }) {',
                          'export function SettingsDialog({ view }: { view: SettingsView }) {\n  const t = useTranslations("Settings");')

# Replace UI strings
strings_to_replace = [
    (r'>\s*Csoportok\s*<', '>{t("groups")}<'),
    (r'placeholder="Új csoport neve, például Work"', 'placeholder={t("new_group_placeholder")}'),
    (r'>\s*Hozzáadás\s*<', '>{t("add")}<'),
    (r'>\s*Mégse\s*<', '>{t("cancel")}<'),
    (r'saving \? "Mentés…" : "Mentés"', 'saving ? t("saving") : t("save")'),
    (r'>\s*Beállítások\s*<', '>{t("settings_title")}<'),
    (r'title={group.hasReports \? "Van tárolt jelentése, ezért nem törölhető" : "Törlés"}', 'title={group.hasReports ? t("group_has_reports_cannot_delete") : t("delete")}'),
    (r'title="Törlés"', 'title={t("delete")}'),
    (r'>\s*Beszámít:\s*<', '>{t("counts_towards")}<'),
    (r'>\s*egyik látható fiókba sem\s*<', '>{t("no_visible_account")}<'),
    (r'>\s*Reset\s*<', '>{t("reset")}<'),
]

for pattern, replacement in strings_to_replace:
    content = re.sub(pattern, replacement, content)

with open("components/settings-dialog.tsx", "w", encoding="utf-8") as f:
    f.write(content)
