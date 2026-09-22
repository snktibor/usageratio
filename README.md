# usageratio

Pehelysúlyú, saját hosztolású használatkövető több AI-szolgáltató vagy fiók (például Claude,
DeepSeek és OpenAI) heti vagy havi tokenkeretéhez. A gépek óránként egy közös, providerenkénti
snapshotot küldenek. A PIN-nel védett dashboardon fiókot lehet váltani; a keret, a csoport- és
gépbontás, valamint a hivatalos százalékkal kalibrált érték együtt vált át.

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
| `lib/settings.ts` | Providerenkénti keretek, közös reset, csoportok és színek (validáció, migráció) |
| `lib/providers.ts` | Providerazonosítók normalizálása és megjelenítési nevei |
| `app/api/settings/route.ts` | GET/PUT végpont a Beállítások panelhez, a PIN-session mögött |
| `app/api/usage/route.ts` | GET ciklus-metaadat és POST ingest: Bearer token, validáció, mentés |
| `lib/usage-store.ts` | Redis adatmodell (írás, olvasás) |
| `lib/cycle.ts` | Heti és havi ciklus számítása időzónával, nyári időszámítással |
| `lib/aggregate.ts`, `lib/dashboard.ts`, `lib/quota.ts` | Összesítés csoportra és gépre, tempóbecslés |
| `lib/ground-truth.ts` | „Valós százalék": a kiválasztott provider bontásának átszámítása (a böngészőben fut) |
| `lib/auth.ts`, `app/actions.ts` | PIN-ellenőrzés, session, próbálkozáskorlát |
| `app/page.tsx`, `components/` | PIN-képernyő és dashboard (Tailwind, sötét téma) |
| `clients/auto/` | Csendes Bash/PowerShell jelentők és a Windows Task Scheduler telepítője |
| `clients/manual/` | Kézzel indítható Bash/PowerShell jelentők konzolos visszajelzéssel |
| `clients/shared/` | A két mód közös jelentési magja és `ccusage-providers.cjs` parsere |
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
     -d "{\"machineId\":\"probe\",\"groupId\":\"Test\",\"providers\":{\"deepseek\":1,\"claude\":2},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
   ```

   `201` a jó válasz. A próba provider/csoport kulcsai az Upstash Data Browserben:
   `usage:events:deepseek:Test` és `usage:events:claude:Test`. A hozzájuk tartozó indexbejegyzések a
   `usage:groups`, `usage:providers` és `usage:machines` hash-ekben vannak.

**Deployment Protection:** az alapbeállítás (*Standard Protection*) a generált címeket
(`usageratio-…-snktibors-projects.vercel.app`) Vercel-bejelentkezés mögé teszi: ezeken a kliensek
`401 Protected deployment` választ kapnak. Az éles domainek (`usageratio.snktibor.hu`,
`usageratio.vercel.app`) nyilvánosak, a klienseket ezért mindig ezekre irányítsd. A védelmet ne
terjeszd ki az éles domainre; ott a Bearer token és a PIN véd.

## 2. Kliensek

Mindkét mód ugyanazt a `clients/shared/` alatti gyűjtőlogikát használja. Az automatikus belépőpontok
normál futáskor nem írnak a konzolra; a manuális belépőpontok siker- vagy hibaüzenetet adnak.

| Kapcsoló | Mire jó |
| --- | --- |
| `--dry-run` / `-DryRun` | kiírja a JSON payloadot, nem küldi el |
| `--providers '{"claude":22000}'` / `-Providers '{"claude":22000}'` | kézi több-provideres snapshot teszteléshez |
| `--tokens N` / `-Tokens N` | kompatibilitási rövidítés: `{"deepseek":N}` |

Kilépési kódok: `0` elküldve · `1` küldési hiba · `2` hibás beállítás · `3` adatolvasási/JSON-hiba.

- Automatikus telepítés: [`setup-auto.md`](setup-auto.md)
- Manuális telepítés: [`setup-manual.md`](setup-manual.md)

## 3. Snapshotok és provider-felismerés

A kliens az aktuális ciklus napjaira szűrt `ccusage daily` eredményt összegzi providerenként. Ez a
ciklus kezdete óta futó összeg, ezért a szerver alapból `snapshot` módban a gép/provider sorozat
legutolsó beküldését veszi. A nyers események megmaradnak, így a mód szükség esetén átállítható:

| `TOKEN_MODE` | A kliens ezt küldi | A dashboard így számol |
| --- | --- | --- |
| `delta` | az előző beküldés óta elhasznált tokeneket | a ciklus beküldéseit összeadja |
| `snapshot` (alap) | a gép/provider futó összegét az aktuális ciklusra | sorozatonként a ciklus legutolsó értékét veszi |
| `counter` | egy folyamatosan növő számlálót („kilométeróra") | a beküldések közti növekményeket adja össze; a visszaesést újraindulásnak veszi |

A provider kulcs kisbetűs azonosító (`a-z`, szám, pont, kötőjel, aláhúzás). Ismert nevekhez a UI
szép címkét ad (`openai` → OpenAI, `deepseek` → DeepSeek); ismeretlen azonosító is használható.
Mivel a `ccusage daily` naptári napokra bont, a ciklus első napját napfelbontással lehet szűrni; a
teljes pontossághoz a reset időpontját tartsd éjfélen (ez az alapbeállítás).

## 4. Beállítások

### A dashboardon: keret, reset, csoportok

A fejléc **Beállítások** gombja (csak belépve látszik) a Redisben tárolt beállításokat szerkeszti,
telepítés nélkül, azonnali hatállyal:

| Beállítás | Értékek |
| --- | --- |
| Keret típusa | **Heti** vagy **Havi** ciklus |
| Keret összege | minden felismert providerhez/fiókhoz külön tokenkeret |
| Reset | heti keretnél a hét napja, havinál a hónap napja (1–31), és az időpont (`ÓÓ:PP`) |
| Maradék tokenek mutatása | kikapcsolva a dashboard sehol nem írja ki, mennyi token maradt, és a túllépés mértékét sem |
| Csoportok | név (amit a gép `groupId`-ként küld) és szín (`#rrggbb`: színválasztó vagy beírt HEX kód) |

- Ha a hónapban nincs olyan nap (31., vagy februárban a 30.), a reset a **hónap utolsó napjára** esik.
- Az **AI-fiók** választó azonnal, új kérés nélkül váltja a teljes dashboardot. Az utoljára választott
  fiók és a providerenként megadott hivatalos százalék a böngészőben külön-külön megmarad.
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

### „Valós százalék": a kiválasztott provider hivatalos értéke

A gépek saját mérése nem mindig egyezik pontosan a provider hivatalos számával, az arányaik viszont
megbízhatók. A dashboard tetején a kiválasztott fiók **valós százaléka** mezőbe (vagy csúszkával)
beírt érték szerint a böngésző azonnal átszámol:

```
egy gép része a keretből = (a gép mért tokenjei / az összes mért token) × hivatalos százalék
```

Példa: a gépek összesen 40 000 tokent mértek, ebből a Mac 10 000-et. Ha a hivatalos érték 20%, a Mac a
teljes keret 5%-át használta el. Ilyenkor a fő sáv, a tempóbecslés, a csoportok és a gépek tokenszámai
is a hivatalos értékhez igazodnak; a panel kiírja a mért értéket és a szorzót is. **Üres mezővel** minden
a gépek saját mérése és a beállított keret szerint számol. Az érték csak a böngészőben él
(`localStorage`), providerenként külön kulcson; a szerverre nem kerül fel, és a ciklus végén magától
törlődik. A tempót a dashboard a beírás időpontjára vetíti.

### A kódban: `lib/config.ts`

Ami nem a panelen van, az a `lib/config.ts` elején; a környezeti változó felülírja az ott lévő
értéket (érvénytelen érték esetén a konstans marad, és figyelmeztetés kerül a naplóba).

| Konstans | Env | Alapérték | Jelentés |
| --- | --- | --- | --- |
| `DEFAULT_LIMIT` | `WEEKLY_LIMIT` | `500000` | minden új provider keretének **kezdőértéke** |
| `DEFAULT_RESET.weekday` | `RESET_WEEKDAY` | `1` | a reset napjának **kezdőértéke**: 0 = vasárnap … 6 = szombat |
| `DEFAULT_RESET.hour/minute` | `RESET_TIME` | `00:00` | a reset időpontjának **kezdőértéke** (`ÓÓ:PP`) |
| `DEFAULT_RESET.timeZone` | `RESET_TIMEZONE` | `Europe/Budapest` | a reset ebben az időzónában értendő, óraátállítással együtt |
| `TOKEN_MODE` | `TOKEN_MODE` | `snapshot` | lásd a 3. pontot |
| `REPORT_INTERVAL_MINUTES` | – | `60` | ebből számol az „Aktív / Késik / Inaktív" jelzés |
| `RETENTION_DAYS` | – | `70` | ennél régebbi nyers jelentések törlődnek (két havi ciklust kell lefednie) |
| `INACTIVE_MACHINE_DAYS` | – | `35` | az ennél régebb óta néma gép lekerül a dashboardról |

A **kezdőérték** addig érvényes, amíg a Beállítások panelen nem mentesz: utána a Redisben tárolt
érték számít, a konstans és a környezeti változó már nem. Az időzóna nincs a panelen, az mindig innen jön.

## 5. API

`GET /api/usage` ugyanazzal a Bearer tokennel visszaadja a szerver aktuális ciklusát, benne a
`sinceDate`, `timeZone` és az ismert `providers` listával. A kliensek az első kettőt átadják a
`ccusage daily` parancsnak; üres új ciklusban a providerlistából nullaértékű életjelet készítenek.

`POST /api/usage`, `Authorization: Bearer <USAGE_API_TOKEN>`, törzs:

```json
{
  "machineId": "mac-home",
  "groupId": "Personal",
  "timestamp": "2026-09-21T10:00:00Z",
  "providers": { "deepseek": 15000, "claude": 22000, "openai": 9000 }
}
```

A `machineId` és a `groupId` 1–64 karakter: betű (ékezetes is), szám, szóköz, `.`, `_`, `-`.
A `providers` 1–20 bejegyzésből áll; minden érték nemnegatív, biztonságos egész JSON-szám. A
`timestamp` ISO 8601, zónajelöléssel. A válasz `groupRegistered` és `providersRegistered` mezője
jelzi az új indexbejegyzéseket.

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
  "limits": { "claude": 500000, "deepseek": 750000, "openai": 1000000 },
  "reset": { "weekday": 1, "monthDay": 1, "hour": 0, "minute": 0 },
  "showRemaining": true,
  "groups": [{ "id": "Work", "color": "#3987e5" }],
  "removedGroups": ["Regi"]
}
```

A `limits` minden ismert provider külön kerete. A `groups` létrehoz vagy átszínez; **a fel nem
sorolt csoportok érintetlenek maradnak** (így egy
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
usage:settings                    STRING {"v":2,"period","limits":{…},"reset":{…},…}
usage:providers                   HASH providerId → első megjelenés (ms)
usage:events:{provider}:{group}   ZSET score = jelentés ideje; member = {"m","t","ts"}
usage:groups                      HASH groupId → {"color":"#rrggbb","ts": első megjelenés}
usage:machines                    HASH providerId:machineId → {"g","ts","t"}
usage:session:{hash}     STRING, 30 napos lejárattal
usage:auth:*             próbálkozás-számlálók lejárattal
```

Provider/csoport páronként külön időrendezett halmaz van. A fiók és a csoport a kulcsban, az időszak
a pontszámtartományban szerepel (`ZRANGE … BYSCORE ciklusKezdet +inf`). Egy dashboard-betöltés az
összes provider modelljét elkészíti és szerializálja, ezért a választó kliensoldalon azonnal vált.

A csoportlista szándékosan **külön hash**, nem a `usage:settings` JSON része. A gépek mind az óra
0. percében jelentenek, ezért az ismeretlen csoport felvételének atominak kell lennie: a `HSETNX` a
jelentés tranzakcióján belül ezt adja, és a már definiált csoporthoz hozzá sem nyúl. Egy JSON
dokumentum „kiolvas–módosít–visszaír" köre mellett az egyszerre érkező jelentések (vagy egy mentés a
panelen) felülírnák egymást.

**Visszafelé kompatibilis:** a v1 `usage:settings.limit` értéke betöltéskor az ismert providerekre
vetül. A régi `usage:events:{groupId}` kulcsokat és a provider nélküli gépbejegyzéseket a rendszer
DeepSeek-adatként olvassa. A korábbi csoportszín-formátum is megmaradt; kézi migráció nem kell.

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

A manuális kliens helyben is kipróbálható:
`USAGERATIO_API_URL=http://localhost:3000/api/usage clients/manual/report-usage.sh --providers
'{"claude":1234,"deepseek":5678}'`.
