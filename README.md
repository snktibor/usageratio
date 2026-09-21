# usageratio

Pehelysúlyú, saját hosztolású használatkövető a Codex heti tokenkeretéhez. A gépek óránként
beküldik a fogyasztásukat, a dashboard pedig megmutatja, hol tart a heti keret, csoportok és gépek
szerint bontva, egy 5 jegyű PIN mögött.

```
 Mac (bash + cron) ──┐
 Windows 1 (PS)  ────┼─ POST /api/usage ─▶ Next.js (Vercel) ─▶ Upstash Redis ◀─ Dashboard (PIN)
 Windows 2 (PS)  ────┘   Bearer token       app/api/usage        ("Vercel KV")     app/page.tsx
```

> **„Vercel KV":** a Vercel a saját KV termékét kivezette, a helyét a Marketplace-en elérhető
> **Upstash for Redis** vette át (ugyanaz a Redis, ugyanúgy a Vercel számláz). A kód ezért az
> `@upstash/redis` klienst használja, és a régi `KV_REST_API_*` változóneveket is érti.

## Mi hol van

| Fájl | Szerep |
| --- | --- |
| `lib/config.ts` | **Heti limit, reset időpontja, token-értelmezés**: itt állítasz mindent |
| `app/api/usage/route.ts` | POST végpont: Bearer token, validáció, mentés |
| `lib/usage-store.ts` | Redis adatmodell (írás, olvasás) |
| `lib/cycle.ts` | Heti ciklus számítása időzónával, nyári időszámítással |
| `lib/aggregate.ts`, `lib/dashboard.ts` | Összesítés csoportra és gépre, tempóbecslés |
| `lib/auth.ts`, `app/actions.ts` | PIN-ellenőrzés, session, próbálkozáskorlát |
| `app/page.tsx`, `components/` | PIN-képernyő és dashboard (Tailwind, sötét téma) |
| `clients/` | `report-usage.sh` (Mac), `report-usage.ps1` + `install-task.ps1` (Windows) |
| `tests/` | Egységtesztek a tiszta logikára (`npm test`) |

## 1. Telepítés Vercelre

1. **Kód a GitHubra**, majd a Vercelen *Add New → Project → Import* (a Next.js-t magától felismeri).
   CLI-vel: `vercel link`, majd `vercel --prod`.
2. **Redis bekötése:** a projektben *Storage → Create Database → Upstash → Redis*, és kösd a
   projekthez mindhárom környezetre. Ez magától beállítja a `KV_REST_API_URL` és a
   `KV_REST_API_TOKEN` változót. (CLI: `vercel integration add upstash`, a varázslóban a Redis terméket
   válaszd.) Régiónak **Frankfurtot (eu-central-1)** válaszd: a `vercel.json` a függvényeket a
   `fra1` régióba teszi, így a Redis néhány ezredmásodpercre van tőlük. Az ingyenes csomag bőven
   elég: egy hét óránkénti jelentése 3 gépről kb. 500 apró rekord.
3. **Két titok** a *Settings → Environment Variables* alatt (Production, és ha kell, Preview):

   | Változó | Érték |
   | --- | --- |
   | `USAGE_API_TOKEN` | a kliensek Bearer tokenje, legalább 16 karakter: `openssl rand -hex 32` |
   | `DASHBOARD_PIN` | pontosan 5 számjegy |

4. **Domain:** *Settings → Domains → Add* → `usageratio.snktibor.hu`. A DNS-szolgáltatónál vedd fel
   a Vercel által kiírt rekordot (jellemzően `CNAME usageratio → cname.vercel-dns.com`).
5. **Redeploy** (a környezeti változók csak új deploymentre érvényesek), majd füstteszt:

   ```bash
   curl -i -X POST https://usageratio.snktibor.hu/api/usage \
     -H "Authorization: Bearer $USAGE_API_TOKEN" -H "Content-Type: application/json" \
     -d "{\"machineId\":\"probe\",\"groupId\":\"Test\",\"tokens\":1,\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
   ```

   `201` a jó válasz. A `Test` csoport külön kulcsba kerül, így nyom nélkül törölhető az Upstash
   konzol Data Browserében vagy CLI-jében:
   `DEL usage:events:Test`, `HDEL usage:groups Test`, `HDEL usage:machines probe`.

Ha a production domainre is bekapcsolod a Vercel *Deployment Protection*-t, a kliensek kérését már a
Vercel elutasítja. Az maradjon kikapcsolva, a védelmet az appban a Bearer token és a PIN adja.

## 2. Kliensek

Mindkét szkript ugyanúgy működik: beolvassa a beállításait egy külön fájlból (így a szkript
cserélhető, a titok pedig nem kerül a repóba), előállítja a tokenszámot, elküldi, és naplóz.

| | `--dry-run` / `-DryRun` | `--tokens N` / `-Tokens N` |
| --- | --- | --- |
| Mire jó | kiírja a JSON-t, nem küld semmit | a megadott számot küldi az olvasó helyett: így a teljes lánc tesztelhető, mielőtt a token-olvasó elkészül |

Kilépési kódok: `0` elküldve · `1` a küldés nem sikerült · `2` hibás beállítás · `3` a token-olvasó hibázott
(amíg a TODO nincs kitöltve, a szkript ezzel áll meg, és **nem küld semmit**).

### Mac: Bash + cron

```bash
mkdir -p ~/.usageratio ~/.config/usageratio
cp clients/report-usage.sh ~/.usageratio/ && chmod 700 ~/.usageratio/report-usage.sh

cat > ~/.config/usageratio/config <<'EOF'
API_URL="https://usageratio.snktibor.hu/api/usage"
API_TOKEN="ide-a-USAGE_API_TOKEN"
MACHINE_ID="mac-studio"
GROUP_ID="Personal"
EOF
chmod 600 ~/.config/usageratio/config

~/.usageratio/report-usage.sh --dry-run --tokens 0   # mit küldene
~/.usageratio/report-usage.sh --tokens 0             # éles próba: 0 tokenes "életjel"
```

Ütemezés: `crontab -e`, és ez az egy sor (minden óra 0. percében):

```cron
0 * * * * /bin/bash "$HOME/.usageratio/report-usage.sh" >/dev/null 2>&1
```

A cron alól futó folyamatnak nincs terminálja és ablaka, tehát eleve láthatatlan; a szkript
ilyenkor semmit nem ír ki, csak a `~/Library/Logs/usageratio.log` fájlba naplóz (magától rövidül).
Alvó Macen a cron nem fut, és nem is pótol: az ébredés utáni következő egész órában jelent újra.

### Windows: PowerShell + Task Scheduler

1. Másold a `clients\report-usage.ps1` és a `clients\install-task.ps1` fájlt ide:
   `%USERPROFILE%\.usageratio\` (ha letöltötted őket: `Unblock-File .\*.ps1`).
2. Ugyanide hozd létre a `config.json` fájlt:

   ```json
   {
     "apiUrl": "https://usageratio.snktibor.hu/api/usage",
     "apiToken": "ide-a-USAGE_API_TOKEN",
     "machineId": "win-desktop",
     "groupId": "Work"
   }
   ```

3. Próba, majd ütemezés **rendszergazdaként indított** PowerShellből:

   ```powershell
   cd $env:USERPROFILE\.usageratio
   powershell -ExecutionPolicy Bypass -File .\report-usage.ps1 -Tokens 0
   powershell -ExecutionPolicy Bypass -File .\install-task.ps1
   ```

Az `install-task.ps1` óránkénti feladatot regisztrál *„Run whether user is logged on or not"*
módban, jelszó tárolása nélkül (S4U). Az ilyen feladat a háttér-munkamenetben fut, ezért **soha
nem jelenik meg ablak, egy villanásra sem**, és kijelentkezve is jelent. (Kézzel ugyanez: Task
Scheduler → Create Task → *Run whether user is logged on or not* + *Do not store password*; Trigger:
Daily, *Repeat task every 1 hour for 1 day*; Action: `powershell.exe`, argumentumok:
`-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "…\report-usage.ps1"`.)
Rendszergazdai jog nélkül: `install-task.ps1 -Interactive`. Ekkor csak bejelentkezve fut, és a
`-WindowStyle Hidden` ellenére egy pillanatra felvillanhat egy ablak. Eltávolítás:
`install-task.ps1 -Uninstall`. Napló: `%USERPROFILE%\.usageratio\usageratio.log`.

## 3. A token-olvasó bekötése

A tényleges Codex-kiolvasás szándékosan nincs megírva. Mindkét szkript tetején ott a blokk:

```
[TODO: INSERT CODEX TOKEN READ LOGIC HERE]
```

Bashben a `read_codex_tokens` függvény törzsét kell kicserélni (a számot a `TOKENS` változóba
teszi, siker esetén `return 0`), PowerShellben a `Read-CodexTokens` függvényét (a számot adja
vissza, hiba esetén `throw`). Hogy a szám **mit jelent**, azt a szerveren a `TOKEN_MODE` dönti el:

| `TOKEN_MODE` | A kliens ezt küldi | A dashboard így számol |
| --- | --- | --- |
| `delta` (alap) | az előző **sikeres** beküldés óta elhasznált tokeneket | a ciklus beküldéseit összeadja |
| `snapshot` | a gép futó összegét az aktuális heti ciklusra | gépenként a ciklus legutolsó értékét veszi |
| `counter` | egy folyamatosan növő számlálót („kilométeróra") | a beküldések közti növekményeket adja össze; a visszaesést újraindulásnak veszi |

A `delta` az, amit a specifikáció leír (a beérkezett tokenek összeadása). Cserébe az olvasónak
emlékeznie kell arra, meddig jelentett már: erre való a `commit_reader_state` / `Save-ReaderState`
függvény, amely **csak a szerver visszaigazolása után** fut le, így egy sikertelen küldés nem vész
el, hanem benne lesz a következő órai számban. Ha az olvasó egyszerűbben tud futó összeget adni,
állítsd át a módot: a szerver a nyers jelentéseket tárolja, ezért a váltás visszamenőleg is érvényes.

## 4. Beállítások

Minden a `lib/config.ts` elején van; a környezeti változó felülírja az ott lévő értéket
(érvénytelen érték esetén a konstans marad, és figyelmeztetés kerül a naplóba).

| Konstans | Env | Alapérték | Jelentés |
| --- | --- | --- | --- |
| `WEEKLY_LIMIT` | `WEEKLY_LIMIT` | `500000` | heti tokenkeret, ehhez mér a fő sáv |
| `WEEKLY_RESET.weekday` | `RESET_WEEKDAY` | `1` | reset napja: 0 = vasárnap … 6 = szombat |
| `WEEKLY_RESET.hour/minute` | `RESET_TIME` | `00:00` | reset időpontja (`ÓÓ:PP`) |
| `WEEKLY_RESET.timeZone` | `RESET_TIMEZONE` | `Europe/Budapest` | ebben az időzónában értendő, óraátállítással együtt |
| `TOKEN_MODE` | `TOKEN_MODE` | `delta` | lásd a 3. pontot |
| `REPORT_INTERVAL_MINUTES` | – | `60` | ebből számol az „Aktív / Késik / Inaktív" jelzés |
| `RETENTION_DAYS` | – | `35` | ennél régebbi nyers jelentések törlődnek |

A dashboard **kizárólag a legutóbbi reset óta** érkezett jelentéseket összesíti. A resethez nem
kell időzített feladat, és nem töröl semmit: a ciklus kezdete egyszerűen a lekérdezés alsó határa.
Ha átírod a reset időpontját, a meglévő adatok az új határok szerint jelennek meg.

## 5. API

`POST /api/usage`, `Authorization: Bearer <USAGE_API_TOKEN>`, törzs:

```json
{ "machineId": "string", "groupId": "string", "tokens": 1234, "timestamp": "2026-09-21T10:00:00Z" }
```

A `machineId` és a `groupId` 1–64 karakter: betű (ékezetes is), szám, szóköz, `.`, `_`, `-`. A
`tokens` nemnegatív egész. A `timestamp` ISO 8601, zónajelöléssel; legfeljebb 10 perccel járhat a
szerver órája előtt, és nem lehet régebbi 35 napnál.

| Kód | Jelentés |
| --- | --- |
| `201` | eltárolva |
| `200` | pontosan ez a jelentés már megvan (`"duplicate": true`): az újraküldés nem számol duplán |
| `400` | hibás JSON vagy mező (`details` felsorolja az összeset) |
| `401` | hiányzó vagy rossz token |
| `413` | 4 KB-nál nagyobb törzs |
| `500` | a szerveren nincs (elég hosszú) `USAGE_API_TOKEN` |
| `503` | a Redis nincs bekötve vagy nem elérhető: a kliens a következő órában újrapróbálja |

## 6. Redis adatmodell

```
usage:events:{groupId}   ZSET  score = a jelentés ideje (epoch ms)
                               member = {"m": machineId, "t": tokens, "ts": ms}
usage:groups             HASH  groupId   → első megjelenés ideje (ebből lesz a csoport állandó színe)
usage:machines           HASH  machineId → {"g": groupId, "ts": ms, "t": tokens}  (utolsó jelentés)
usage:session:{hash}     STRING, 30 napos lejárattal
usage:auth:*             próbálkozás-számlálók lejárattal
```

Csoportonként egy időrendezett halmaz: így mindkét szűrés egy-egy natív Redis-művelet. A csoport
maga a kulcs, az időszak pedig pontszám-tartomány (`ZRANGE … BYSCORE ciklusKezdet +inf`). A tagok
(gép, token, idő) szerint egyediek, ezért a megismételt POST hatástalan. Íráskor a 35 napnál régebbi
elemek törlődnek (`ZREMRANGEBYSCORE`). Egy dashboard-betöltés két körút a Redishez.

## 7. Biztonság

- **PIN nélkül nincs adat.** Az oldal szerveroldalon renderel: session nélkül a Redis-lekérdezés le
  sem fut, a válasz csak a PIN-űrlapot tartalmazza. A PIN csak a szerveren létezik (`DASHBOARD_PIN`),
  az összehasonlítás időzítésbiztos.
- **Session:** véletlen azonosító `HttpOnly`, `Secure`, `SameSite=Lax` sütiben, a Redisben tárolva
  (30 nap). A *Kilépés* azonnal érvényteleníti; a `DASHBOARD_PIN` cseréje minden böngészőt kiléptet.
- **Próbálkozáskorlát:** IP-címenként 5 próba / 15 perc, és összesen 30 hibás próba / óra, hogy
  sok IP-ről se lehessen végigpróbálni. Egy 5 jegyű PIN-nek csak 100 000 változata van, ez a korlát
  teszi használhatóvá; cserébe egy kitartó támadó időlegesen téged is kizárhat a belépésből.
- **Beküldés:** hosszú véletlen Bearer token, időzítésbiztos összehasonlítással. A kliensek a tokent
  nem parancssori argumentumként adják át, így a folyamatlistában sem látszik.
- A keresők ki vannak tiltva (`robots.txt`, `X-Robots-Tag`), az oldal nem ágyazható be (`X-Frame-Options`).

## 8. Helyi fejlesztés

```bash
npm install
cp .env.example .env.local      # töltsd ki a USAGE_API_TOKEN és a DASHBOARD_PIN értékét
npm run redis:up                # helyi Redis + Upstash-kompatibilis REST proxy (Docker)
npm run dev                     # http://localhost:3000

npm test                        # egységtesztek
npm run typecheck
npm run redis:down
```

A kliensek helyben is kipróbálhatók:
`USAGERATIO_API_URL=http://localhost:3000/api/usage clients/report-usage.sh --tokens 1234`.
