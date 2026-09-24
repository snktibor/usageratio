import json

hu_settings = {
  "groups": "Csoportok",
  "new_group_placeholder": "Új csoport neve, például Work",
  "add": "Hozzáadás",
  "cancel": "Mégse",
  "saving": "Mentés…",
  "save": "Mentés",
  "settings_title": "Beállítások",
  "group_has_reports_cannot_delete": "Van tárolt jelentése, ezért nem törölhető",
  "delete": "Törlés",
  "counts_towards": "Beszámít:",
  "no_visible_account": "egyik látható fiókba sem",
  "reset": "Reset",
  "group_name_rules": "A csoportnév 1–64 karakter lehet: betű, szám, szóköz, pont, kötőjel és aláhúzás, az elején betűvel vagy számmal.",
  "at_least_one_visible_account": "Legalább egy AI-fióknak látszania kell a dashboardon.",
  "reset_time_format_error": "Add meg a reset időpontját óra:perc formában, például 00:00.",
  "token_saved": "A token elmentve.",
  "token_modified": "A token módosítva.",
  "session_expired": "A munkamenet lejárt. Lépj be újra a PIN-kóddal, utána mentsd újra a tokent.",
  "token_rejected": "A szerver elutasította a tokent: 16–512 szóköz nélküli ASCII karakter lehet.",
  "store_unavailable": "A mentés nem sikerült, az adattár most nem érhető el. Próbáld újra kicsit később.",
  "server_did_not_respond": "A mentés nem sikerült: a szerver nem válaszolt. Ellenőrizd a kapcsolatot, és próbáld újra.",
  "loading_status": "Állapot betöltése…",
  "new_token_placeholder": "Új token a régi helyére",
  "server_token_placeholder": "A szerver USAGE_API_TOKEN-je",
  "modify_token": "Token módosítása",
  "add_token": "Token hozzáadása",
  "copy_failed": "A másolás nem sikerült. Próbáld újra.",
  "token_on_clipboard": "Token a vágólapon",
  "copying": "Másolás…",
  "copy_token": "Token másolása",
  "audit_notice": "A lekérés az auditnaplóba kerül.",
  "token_on_clipboard_hidden": "A token a vágólapon.",
  "provide_in_settings": " A dashboard Beállítások paneljén adhatod meg.",
  "pin_checking": "Ellenőrzés…",
  "pin_login": "Belépés"
}

en_settings = {
  "groups": "Groups",
  "new_group_placeholder": "New group name, e.g. Work",
  "add": "Add",
  "cancel": "Cancel",
  "saving": "Saving...",
  "save": "Save",
  "settings_title": "Settings",
  "group_has_reports_cannot_delete": "Has stored reports, cannot be deleted",
  "delete": "Delete",
  "counts_towards": "Counts towards:",
  "no_visible_account": "none of the visible accounts",
  "reset": "Reset",
  "group_name_rules": "The group name can be 1-64 characters: letter, number, space, dot, hyphen, underscore, starting with a letter or number.",
  "at_least_one_visible_account": "At least one AI account must be visible on the dashboard.",
  "reset_time_format_error": "Provide the reset time in hour:minute format, e.g., 00:00.",
  "token_saved": "Token saved.",
  "token_modified": "Token modified.",
  "session_expired": "Session expired. Log in again with the PIN code, then save the token.",
  "token_rejected": "The server rejected the token: it must be 16-512 ASCII characters without spaces.",
  "store_unavailable": "Save failed, the data store is currently unavailable. Try again later.",
  "server_did_not_respond": "Save failed: the server did not respond. Check your connection and try again.",
  "loading_status": "Loading status...",
  "new_token_placeholder": "New token to replace the old one",
  "server_token_placeholder": "The server's USAGE_API_TOKEN",
  "modify_token": "Modify token",
  "add_token": "Add token",
  "copy_failed": "Copy failed. Try again.",
  "token_on_clipboard": "Token on clipboard",
  "copying": "Copying...",
  "copy_token": "Copy token",
  "audit_notice": "The request is logged in the audit trail.",
  "token_on_clipboard_hidden": "The token is on the clipboard.",
  "provide_in_settings": " You can provide it on the dashboard's Settings panel.",
  "pin_checking": "Checking...",
  "pin_login": "Log in"
}

with open("messages/hu.json", "r", encoding="utf-8") as f:
    hu_data = json.load(f)

hu_data["Settings"] = hu_settings

with open("messages/hu.json", "w", encoding="utf-8") as f:
    json.dump(hu_data, f, ensure_ascii=False, indent=2)

with open("messages/en.json", "r", encoding="utf-8") as f:
    en_data = json.load(f)

en_data["Settings"] = en_settings

with open("messages/en.json", "w", encoding="utf-8") as f:
    json.dump(en_data, f, ensure_ascii=False, indent=2)
