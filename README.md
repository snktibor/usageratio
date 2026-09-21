# usageratio

Pehelysúlyú, saját hosztolású használatkövető a Codex heti vagy havi tokenkeretéhez. A gépek óránként
beküldik a fogyasztásukat, a dashboard pedig megmutatja, hol tart a keret, csoportok és gépek
szerint bontva, egy 5 jegyű PIN mögött. A keret, a reset és a csoportok a dashboardon állíthatók; a
hivatalos Codex-százalék beírásával a bontás a valós fogyasztáshoz igazítható.

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
| `lib/config.ts` | Telepítési beállítások (időzóna, token-értelmezés, megőrzés) és a keret **kezdőértékei** |
| `lib/settings.ts` | A dashboardon szerkeszthető beállítások: keret, reset, csoportok és színeik (validáció, tiszta logika) |
| `app/api/settings/route.ts` | GET/PUT végpont a Beállítások panelhez, a PIN-session mögött |
| `app/api/usage/route.ts` | POST végpont: Bearer token, validáció, mentés, ismeretlen csoport felvétele |
| `lib/usage-store.ts` | Redis adatmodell (írás, olvasás) |
| `lib/cycle.ts` | Heti és havi ciklus számítása időzónával, nyári időszámítással |
| `lib/aggregate.ts`, `lib/dashboard.ts`, `lib/quota.ts` | Összesítés csoportra és gépre, tempóbecslés |
| `lib/ground-truth.ts` | „Valós százalék": a bontás átszámítása a hivatalos Codex-értékre (a böngészőben fut) |
| `lib/auth.ts`, `app/actions.ts` | PIN-ellenőrzés, session, próbálkozáskorlát |
| `app/page.tsx`, `components/` | PIN-képernyő és dashboard (Tailwind, sötét téma) |
| `clients/` | `report-usage.sh` (Mac), `report-usage.ps1` + `install-task.ps1` (Windows) |
| `tests/` | Egységtesztek a tiszta logikára (`npm test`) |

## 1. Telepítés Vercelre

1. **Kód a GitHubra**, majd a Vercelen *Add New → Project → Import* (a Next.js-t magától felismeri).
   CLI-vel: `vercel link`, majd `vercel --prod`. A `main` ágra érkező push élesbe telepít.
   (Ha a projekt még üres repóval jött létre, a presetje „Other" marad, és a build a hiányzó
   `public` mappára hivatkozva elbukik: ezért rögzíti a `vercel.json` a `"framework": "nextjs"` értéket.)
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

4. **Domain:** *Settings → Domains → Add* → `usageratio.snktibor.hu`, majd a DNS-szolgáltatónál
   (a `snktibor.hu` a Cloudflare-nél van) vedd fel a Vercel által kiírt rekordot:

   | Típus | Név | Cél | Proxy |
   | --- | --- | --- | --- |
   | `CNAME` | `usageratio` | `2f9bd857134fd2c4.vercel-dns-017.com` | **DNS only** (szürke felhő) |

   A Cloudflare-proxyt hagyd kikapcsolva: bekapcsolva a Vercel nem tud tanúsítványt kiállítani, és
   minden látogató a Cloudflare IP-címéről érkezne, ami az IP-nkénti PIN-korlátot értelmetlenné teszi.
5. **Redeploy** (a környezeti változók csak új deploymentre érvényesek), majd füstteszt:

   ```bash
   curl -i -X POST https://usageratio.snktibor.hu/api/usage \
     -H "Authorization: Bearer $USAGE_API_TOKEN" -H "Content-Type: application/json" \
     -d "{\"machineId\":\"probe\",\"groupId\":\"Test\",\"tokens\":1,\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
   ```

   `201` a jó válasz. A `Test` csoport külön kulcsba kerül (és felkerül a Beállítások csoportlistájára
   is), így nyom nélkül törölhető az Upstash konzol Data Browserében vagy CLI-jében:
   `DEL usage:events:Test`, `HDEL usage:groups Test`, `HDEL usage:machines probe`.

**Deployment Protection:** az alapbeállítás (*Standard Protection*) a generált címeket
(`usageratio-…-snktibors-projects.vercel.app`) Vercel-bejelentkezés mögé teszi: ezeken a kliensek
`401 Protected deployment` választ kapnak. Az éles domainek (`usageratio.snktibor.hu`,
`usageratio.vercel.app`) nyilvánosak, a klienseket ezért mindig ezekre irányítsd. A védelmet ne
terjeszd ki az éles domainre; ott a Bearer token és a PIN véd.

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

### A dashboardon: keret, reset, csoportok

A fejléc **Beállítások** gombja (csak belépve látszik) a Redisben tárolt beállításokat szerkeszti,
telepítés nélkül, azonnali hatállyal:

| Beállítás | Értékek |
| --- | --- |
| Keret típusa | **Heti** vagy **Havi** ciklus |
| Keret összege | a ciklus tokenkerete, ehhez mér a fő sáv |
| Reset | heti keretnél a hét napja, havinál a hónap napja (1–31), és az időpont (`ÓÓ:PP`) |
| Maradék tokenek mutatása | kikapcsolva a dashboard sehol nem írja ki, mennyi token maradt, és a túllépés mértékét sem |
| Csoportok | név (amit a gép `groupId`-ként küld) és szín (`#rrggbb`: színválasztó vagy beírt HEX kód) |

- Ha a hónapban nincs olyan nap (31., vagy februárban a 30.), a reset a **hónap utolsó napjára** esik.
- A szín HEX kód, nem Tailwind-osztály: a Tailwind fordításkor állítja elő a CSS-t, egy Redisből
  érkező osztálynévhez nem lenne stílus. A színt a komponensek inline stílusként alkalmazzák.
- **Ismeretlen csoport:** ha egy gép olyan `groupId`-t küld, amely nincs a listán, a rendszer
  magától felveszi, véletlen (a sötét háttéren olvasható sávból húzott) színnel. A szín utólag átírható.
- **Maradék tokenek:** a kapcsoló csak a megjelenítést érinti. Kikapcsolva eltűnik a „Maradt" / „Túllépés"
  blokk, és a keret elfogyásakor a szöveg a tokenek helyett azt mondja meg, mikor jön a következő reset.
  A százalék, az elfogyott mennyiség és a reset ideje megmarad.
- **Törlés:** csak olyan csoport törölhető, amelynek nincs tárolt jelentése. Különben a jelentései
  eltűnnének a dashboardról, a következő beküldéskor pedig a csoport új színnel térne vissza.

A dashboard **kizárólag a legutóbbi reset óta** érkezett jelentéseket összesíti. A resethez nem
kell időzített feladat, és nem töröl semmit: a ciklus kezdete egyszerűen a lekérdezés alsó határa.
Ha átírod a resetet vagy a keret típusát, a meglévő adatok az új határok szerint jelennek meg.

### „Valós százalék": a hivatalos Codex-érték

A gépek saját mérése sosem egyezik pontosan a Codex hivatalos számával (egy gép offline volt, egy
beküldés elveszett), az arányaik viszont megbízhatók. A dashboard tetején lévő **„Aktuális hivatalos
Codex fogyasztás (%)"** mezőbe (vagy csúszkával) beírt érték szerint a böngésző azonnal átszámol:

```
egy gép része a keretből = (a gép mért tokenjei / az összes mért token) × hivatalos százalék
```

Példa: a gépek összesen 40 000 tokent mértek, ebből a Mac 10 000-et. Ha a hivatalos érték 20%, a Mac a
teljes keret 5%-át használta el. Ilyenkor a fő sáv, a tempóbecslés, a csoportok és a gépek tokenszámai
is a hivatalos értékhez igazodnak; a panel kiírja a mért értéket és a szorzót is. **Üres mezővel** minden
a gépek saját mérése és a beállított keret szerint számol. Az érték csak a böngészőben él
(`localStorage`), a szerverre nem kerül fel, és a ciklus végén magától törlődik. A tempót a dashboard
a beírás időpontjára vetíti, ezért a panel azt is mutatja, mikor adtad meg.

### A kódban: `lib/config.ts`

Ami nem a panelen van, az a `lib/config.ts` elején; a környezeti változó felülírja az ott lévő
értéket (érvénytelen érték esetén a konstans marad, és figyelmeztetés kerül a naplóba).

| Konstans | Env | Alapérték | Jelentés |
| --- | --- | --- | --- |
| `DEFAULT_LIMIT` | `WEEKLY_LIMIT` | `500000` | a keret **kezdőértéke** |
| `DEFAULT_RESET.weekday` | `RESET_WEEKDAY` | `1` | a reset napjának **kezdőértéke**: 0 = vasárnap … 6 = szombat |
| `DEFAULT_RESET.hour/minute` | `RESET_TIME` | `00:00` | a reset időpontjának **kezdőértéke** (`ÓÓ:PP`) |
| `DEFAULT_RESET.timeZone` | `RESET_TIMEZONE` | `Europe/Budapest` | a reset ebben az időzónában értendő, óraátállítással együtt |
| `TOKEN_MODE` | `TOKEN_MODE` | `delta` | lásd a 3. pontot |
| `REPORT_INTERVAL_MINUTES` | – | `60` | ebből számol az „Aktív / Késik / Inaktív" jelzés |
| `RETENTION_DAYS` | – | `70` | ennél régebbi nyers jelentések törlődnek (két havi ciklust kell lefednie) |
| `INACTIVE_MACHINE_DAYS` | – | `35` | az ennél régebb óta néma gép lekerül a dashboardról |

A **kezdőérték** addig érvényes, amíg a Beállítások panelen nem mentesz: utána a Redisben tárolt
érték számít, a konstans és a környezeti változó már nem. Az időzóna nincs a panelen, az mindig innen jön.

## 5. API

`POST /api/usage`, `Authorization: Bearer <USAGE_API_TOKEN>`, törzs:

```json
{ "machineId": "string", "groupId": "string", "tokens": 1234, "timestamp": "2026-09-21T10:00:00Z" }
```

A `machineId` és a `groupId` 1–64 karakter: betű (ékezetes is), szám, szóköz, `.`, `_`, `-`. A
`tokens` nemnegatív egész. A `timestamp` ISO 8601, zónajelöléssel; legfeljebb 10 perccel járhat a
szerver órája előtt, és nem lehet régebbi 70 napnál. A válasz `groupRegistered` mezője jelzi, ha a
`groupId` új volt, és most került fel a csoportlistára.

| Kód | Jelentés |
| --- | --- |
| `201` | eltárolva |
| `200` | pontosan ez a jelentés már megvan (`"duplicate": true`): az újraküldés nem számol duplán |
| `400` | hibás JSON vagy mező (`details` felsorolja az összeset) |
| `401` | hiányzó vagy rossz token |
| `413` | 4 KB-nál nagyobb törzs |
| `500` | a szerveren nincs (elég hosszú) `USAGE_API_TOKEN` |
| `503` | a Redis nincs bekötve vagy nem elérhető: a kliens a következő órában újrapróbálja |

### `/api/settings`: a Beállítások panel végpontja

A dashboard session-sütijével hitelesít (nem a Bearer tokennel): érvényes PIN-session nélkül mindkét
metódus `401`-et ad, és semmilyen adathoz nem nyúl.

`GET` visszaadja a beállításokat és a csoportokat (`hasReports`: van-e tárolt jelentése). `PUT` törzse:

```json
{
  "period": "weekly",
  "limit": 500000,
  "reset": { "weekday": 1, "monthDay": 1, "hour": 0, "minute": 0 },
  "showRemaining": true,
  "groups": [{ "id": "Work", "color": "#3987e5" }],
  "removedGroups": ["Regi"]
}
```

A `groups` létrehoz vagy átszínez; **a fel nem sorolt csoportok érintetlenek maradnak** (így egy
közben magától felkerült csoportot a mentés nem töröl ki). A `weekday` és a `monthDay` mindig
tárolódik, hogy a keret típusának visszaváltásakor megmaradjon a korábbi választás. A keret mezői
mind kötelezők, a `showRemaining` is: a `PUT` a teljes beállítást írja felül, semmit nem pótol
alapértékkel. (A Redisben lévő, a kapcsoló előtt mentett dokumentum viszont gond nélkül olvasódik:
ott a hiányzó mező bekapcsoltat jelent.)

| Kód | Jelentés |
| --- | --- |
| `200` | elmentve |
| `400` | hibás JSON vagy mező (`details` felsorolja az összeset) |
| `401` | nincs érvényes session |
| `403` | idegen `Origin` (a `SameSite=Lax` süti mellé második védvonal) |
| `409` | egy törlendő csoportnak van tárolt jelentése (`groups`); **semmi nem lett elmentve** |
| `413` / `415` | 16 KB-nál nagyobb, illetve nem JSON törzs |
| `503` | a Redis nincs bekötve vagy nem elérhető |

## 6. Redis adatmodell

```
usage:settings           STRING {"v": 1, "period", "limit", "reset": {…}, "showRemaining", "updatedAt": ms}
                               a keret, ahogy a Beállítások panel elmentette
usage:events:{groupId}   ZSET  score = a jelentés ideje (epoch ms)
                               member = {"m": machineId, "t": tokens, "ts": ms}
usage:groups             HASH  groupId   → {"color": "#rrggbb", "ts": első megjelenés (ms)}
usage:machines           HASH  machineId → {"g": groupId, "ts": ms, "t": tokens}  (utolsó jelentés)
usage:session:{hash}     STRING, 30 napos lejárattal
usage:auth:*             próbálkozás-számlálók lejárattal
```

Csoportonként egy időrendezett halmaz: így mindkét szűrés egy-egy natív Redis-művelet. A csoport
maga a kulcs, az időszak pedig pontszám-tartomány (`ZRANGE … BYSCORE ciklusKezdet +inf`). A tagok
(gép, token, idő) szerint egyediek, ezért a megismételt POST hatástalan. Íráskor a 70 napnál régebbi
elemek törlődnek (`ZREMRANGEBYSCORE`). Egy dashboard-betöltés két körút a Redishez: az első hozza a
beállításokat és az indexeket, mert a beállítás dönti el, meddig kell visszaolvasni a jelentéseket.

A csoportlista szándékosan **külön hash**, nem a `usage:settings` JSON része. A gépek mind az óra
0. percében jelentenek, ezért az ismeretlen csoport felvételének atominak kell lennie: a `HSETNX` a
jelentés tranzakcióján belül ezt adja, és a már definiált csoporthoz hozzá sem nyúl. Egy JSON
dokumentum „kiolvas–módosít–visszaír" köre mellett az egyszerre érkező jelentések (vagy egy mentés a
panelen) felülírnák egymást.

**Visszafelé kompatibilis:** a csoportszínek előtti `usage:groups` bejegyzés értéke egy csupasz
időbélyeg volt. Az ilyet a kód ma is olvassa (a csoport az első megjelenés sorrendjében kap egy
alapszínt), és az első mentés a panelen az új formátumra írja át. Migrációs lépés nem kell.

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
- **Beállítások:** a `/api/settings` ugyanazt a sessiont ellenőrzi, mint az oldal; session nélkül sem
  olvasni, sem írni nem enged. Az írás csak azonos eredetről (`Origin`) és JSON törzzsel fogadható el.
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
