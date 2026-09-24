import re

with open("components/api-token-settings.tsx", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace('  timeZone: string;\n}) {',
                          '  timeZone: string;\n}) {\n  const t = useTranslations("Settings");')

with open("components/api-token-settings.tsx", "w", encoding="utf-8") as f:
    f.write(content)
