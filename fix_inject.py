import re

with open("components/settings-dialog.tsx", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace('function SettingsForm({ view, titleId, onClose }: { view: SettingsView; titleId: string; onClose: () => void }) {',
                          'function SettingsForm({ view, titleId, onClose }: { view: SettingsView; titleId: string; onClose: () => void }) {\n  const t = useTranslations("Settings");')

content = content.replace('  onRemove: () => void;\n}) {\n  const modeName = useId();',
                          '  onRemove: () => void;\n}) {\n  const t = useTranslations("Settings");\n  const modeName = useId();')

with open("components/settings-dialog.tsx", "w", encoding="utf-8") as f:
    f.write(content)
