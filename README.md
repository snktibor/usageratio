# usageratio

Pehelysúlyú, saját hosztolású használatkövető több AI-szolgáltató vagy fiók (például Claude,
DeepSeek és OpenAI) heti vagy havi tokenkeretéhez. A gépek óránként egy közös, providerenkénti
snapshotot küldenek. A PIN-nel védett dashboardon fiókot lehet váltani; a keret, a csoport- és
gépbontás, valamint a hivatalos százalékkal kalibrált érték együtt vált át. Két grafikon mutatja a
ciklus menetét: a keret fogyását csoportonként és összesen, valamint a kiválasztott modell
tokenhasználatát csoportonként.

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
| `lib/settings.ts` | Opcionális providerenkénti tokenkeretek, közös reset, látható fiókok, csoportok, színek és hogy a csoport mely fiókokba számít (validáció, migráció) |
| `lib/providers.ts` | Providerazonosítók normalizálása és megjelenítési nevei |
| `app/api/settings/route.ts` | GET/PUT végpont a Beállítások panelhez, a PIN-session mögött |
| `app/api/usage/route.ts` | GET ciklus-metaadat és POST ingest: Bearer token, validáció, mentés |
| `lib/usage-store.ts` | Redis adatmodell (írás, olvasás) |
| `lib/cycle.ts` | Heti és havi ciklus számítása időzónával, nyári időszámítással |
| `lib/aggregate.ts`, `lib/dashboard.ts`, `lib/quota.ts` | Összesítés csoportra és gépre, tempóbecslés |
| `lib/sub-limits.ts` | Alkeretek (pl. Claude/Fable): modell → alkeret, a jelentések szétválasztása, mért állás |
| `lib/timeline.ts`, `lib/models.ts`, `lib/chart.ts` | A grafikonok idősora (csoportonként és modellenként), modellnevek, tengelyek |
| `lib/ground-truth.ts` | „Valós százalék": a kiválasztott provider bontásának átszámítása (a böngészőben fut) |
| `lib/auth.ts`, `app/actions.ts` | PIN-ellenőrzés, session, próbálkozáskorlát |
| `app/page.tsx`, `components/` | PIN-képernyő és dashboard (Tailwind, sötét téma) |
| `app/setup/page.tsx`, `components/setup-view.tsx` | A **Telepítés** oldal: rendszer és mód, ZIP-letöltés, másolható fájlok |
| `app/api/setup/route.ts`, `lib/setup.ts`, `lib/setup-package.ts`, `lib/zip.ts` | A telepítőcsomag: fájllista, generált config és README, ZIP |
| `app/api/api-token/`, `lib/token-vault.ts`, `lib/secret-box.ts`, `lib/api-token.ts` | A tárolt API-token: AES-256-GCM titkosítás, másolás a Telepítés oldalon, auditnapló |
| `clients/setup/` | A csomagok telepítői: `install.sh` (macOS), `install.ps1` és `install.cmd` (Windows) |
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
   | `TOKEN_ENCRYPTION_KEY` | nem kötelező: a Telepítés oldal *Token másolása* gombjához, 32 bájt: `openssl rand -base64 32` |

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

### Telepítés a dashboardról

A fejléc **Telepítés** gombja a `/setup` oldalra visz (ez is a PIN mögött van). Ott kiválasztod a gép
rendszerét (macOS vagy Windows), a futtatás módját (automatikus vagy manuális), a csoportot (a meglévők
egy kattintással), és ha kell, a gép azonosítóját. Utána két út van, ugyanazzal az eredménnyel:

- **Letöltés ZIP-ben:** kész csomag a telepítővel. macOS-en
  `bash ~/Downloads/usageratio-macos-auto/install.sh`, Windowson kibontás után dupla kattintás az
  `install.cmd`-re.
- **Másold és hozd létre:** ugyanezek a fájlok másolható blokkokban, a nevükkel és a végleges helyükkel.
  A mappa helye mindegy, csak minden fájl egy mappába kerüljön. Mentés a vágólapról:
  `pbpaste > fájlnév`, Windowson a lap első parancsa által felvett `paste fájlnév`.

A token beírásánál a **Token másolása** gomb a vágólapra teszi a Beállítások panelen megadott tokent
(lásd lent: [API-token](#api-token-a-telepítés-oldal-másológombjához)). A token nem része az oldalnak:
a gomb kattintáskor kéri le a szervertől, és a lekérés az auditnaplóba kerül.

A telepítő (`clients/setup/`):

1. a mellette lévő `report-usage-auto.*` vagy `report-usage-manual.*` fájlból tudja, melyik módot telepíti;
2. rejtett beírással bekéri a `USAGE_API_TOKEN`-t, és egy `GET /api/usage` kéréssel ellenőrzi (`401`-nél
   újra kéri; a `USAGERATIO_API_TOKEN` környezeti változóval kérdés nélkül fut). **A csomag nem
   tartalmaz tokent.** Újratelepítéskor Enterrel megtartható a már mentett token;
3. a fájlokat a megszokott helyükre másolja (`~/.usageratio/{auto,manual,shared}`, a config
   `~/.config/usageratio/config`, 600-as joggal; Windowson `%USERPROFILE%\.usageratio`). A letöltött mappa
   ezért bárhol lehet, és utána törölhető; a macOS cron a Letöltések vagy a Dokumentumok mappát nem is olvashatná;
4. üresen hagyott gépazonosítónál megtartja a gépen már használt azonosítót, első telepítéskor a számítógép
   nevét írja be, így egy újratelepítés nem bontja ketté a gép történetét;
5. elküld egy próbajelentést, majd beállítja a cront vagy a `sync-tokens` aliast (`~/.zshrc`), illetve
   Windowson az ütemezett feladatot (ehhez egyszer rendszergazdai jogot kér) vagy az asztali „Sync tokens”
   parancsikont.

Ha a `node` nem a szokásos helyen van (nvm, volta), a macOS-telepítő egy `PATH=` sort is ír a configba,
hogy a cron is megtalálja.

### Kapcsolók és kilépési kódok

| Kapcsoló | Mire jó |
| --- | --- |
| `--dry-run` / `-DryRun` | kiírja a JSON payloadot, nem küldi el |
| `--providers '{"claude":22000}'` / `-Providers '{"claude":22000}'` | kézi több-provideres snapshot teszteléshez |
| `--tokens N` / `-Tokens N` | kompatibilitási rövidítés: `{"deepseek":N}` |

Kilépési kódok: `0` elküldve · `1` küldési hiba · `2` hibás beállítás · `3` adatolvasási/JSON-hiba.

Csomag nélküli, parancssori telepítés a repóból:

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

A kliens a providerek mellett a **modellenkénti bontást** is elküldi (`models`, lásd az 5. pontot): a
`ccusage` napi `modelBreakdowns` adataiból, providerenként legfeljebb 20, összesen legfeljebb 60 modellt,
a legnagyobbaktól kezdve. Ha a bontás valamiért nem készül el, a jelentés nélküle megy el. A régebbi
kliensek bontás nélkül jelentenek: az ő tokenjeik a providerösszegben számítanak, a modellgrafikonon nem.
Snapshot módban a frissített kliens első jelentése a ciklus eleje óta futó modellösszegeket hozza, így a
grafikon attól a ponttól teljes.

A kliens a **napi bontást** is elküldi (`days`): ugyanazt a snapshotot naptári napokra szedve (a
ciklus időzónájában), modellenként is. A szerver ebből minden már lezárult nap végére, helyi éjfélre
egy **napzáró pontot** ír a gép sorozatába: a gép addigi futó összegét. Így a grafikonokon a gép
első jelentése előtti napok (egy ciklus közben telepített gépnél) és a manuális módban kihagyott
napok is a saját napjukon látszanak, nem a következő jelentés pillanatában ugranak fel. Az
összesítésben ezek a tokenek eddig is benne voltak, hiszen a snapshot a ciklus eleje óta számol. A
napzáró pont nem jelentés: a géptábla jelentésszámlálója és a „késik” jelzés nem veszi figyelembe,
és csak `snapshot` módban olvasódik.

A Claude Code használatát a kliens **óránként** is bontja: a `ccusage daily` előtt lefuttatja a
`ccusage blocks --session-length 1` parancsot, amely egész órás blokkokat ad. Egy nap órái csak akkor
mennek fel, ha tokenre kiadják a napot (a mai napon kevesebbet is adhatnak, a folyamatban lévő óra
miatt); ha nem (például egy másik ügynök is Claude-modellt használt aznap), a nap egyben megy. A
szerver ilyenkor minden lezárult óra végére is napzáró pontot ír, modellbontás nélkül (a blokkokban
nincs modellenkénti szám). A reset napján a ciklus kezdete előtti órák kimaradnak a Claude-összegből,
így a reset napjának délelőttje nem számít bele két ciklusba; az aznapi modellbontás ennek arányában
csökken. Minden más (Codex és a többi ügynök) napi felbontású marad: a `blocks` csak a Claude Code-ot
látja, ezért ott a visszatöltött szakasz napi lépcsőkben emelkedik. Ami egy ciklusból a reset előtt jelentés nélkül
marad (manuális módban az utolsó futtatás és a reset közti rész), azt a következő ciklus jelentései
nem hozzák vissza: azok csak az új ciklus napjait tartalmazzák.

A provider kulcs kisbetűs azonosító (`a-z`, szám, pont, kötőjel, aláhúzás). Ismert nevekhez a UI
szép címkét ad (`openai` → OpenAI, `deepseek` → DeepSeek); ismeretlen azonosító is használható.
Mivel a `ccusage daily` naptári napokra bont, a ciklus első napját napfelbontással lehet szűrni: a
Claude Code-ot a fenti órás bontás pontosan a reset pillanatától számolja, a többi ügynöknél viszont
a reset napjának egésze az új ciklusba kerül. Ott a teljes pontossághoz a reset időpontját tartsd
éjfélen (ez az alapbeállítás).

## 4. Beállítások

### A dashboardon: AI-fiókok, keret, reset, csoportok

A fejléc **Beállítások** gombja (csak belépve látszik) a Redisben tárolt beállításokat szerkeszti,
telepítés nélkül, azonnali hatállyal:

| Beállítás | Értékek |
| --- | --- |
| AI-fiókok | melyik felismert provider/fiók látszik a dashboardon és az **AI-fiók** választóban |
| Keret típusa | **Heti** vagy **Havi** ciklus |
| Tokenkeret használata | alapból **ki**: a dashboard csak a mért tokenekből és a beírt hivatalos százalékból számol |
| Keret összege | bekapcsolt tokenkeretnél minden felismert providerhez/fiókhoz külön tokenkeret |
| Alkeretek | fiókonként külön mért keretek, például a Claude-nál a Fable: név, modellek, **önálló keret** vagy **a keret része** (legfeljebb X%) |
| Maradék tokenek mutatása | bekapcsolt tokenkeretnél: kikapcsolva sehol nem látszik, mennyi token maradt, és a túllépés mértéke sem |
| Reset | heti keretnél a hét napja, havinál a hónap napja (1–31), és az időpont (`ÓÓ:PP`) |
| Csoportok | név (amit a gép `groupId`-ként küld), szín (`#rrggbb`: színválasztó vagy beírt HEX kód), és hogy mely AI-fiókokba számít bele |

- **AI-fiókok:** a kikapcsolt fiók eltűnik a dashboardról és a választóból (például ha a Codexet nem
  akarod látni). A jelentéseit a szerver továbbra is tárolja, így visszakapcsolva az előzményekkel együtt
  tér vissza. Legalább egy fióknak látszania kell.
- **Beszámít:** csoportonként megadható, melyik AI-fiók fogyasztásába számít bele. Ha például a `Work`
  csoportnál csak az OpenAI (Codex) van bekapcsolva, a Claude és a DeepSeek dashboardján a `Work` gépei és
  tokenjei nem látszanak, és a hivatalos százalék is csak a többi csoport között oszlik meg. A jelentések
  itt is tárolva maradnak. Új csoport és új provider alapból mindenhová beszámít.
- **Alkeretek:** egy fiókon belül külön mért keret, a dashboardon a fő csúszka alatt saját, kisebb
  csúszkával (lásd lent). Hogy mely modellek tartoznak hozzá, azt a modellazonosító egy-egy része adja meg
  (`fable` → `claude-fable-5-1`); egy modell az első olyan alkeretbe kerül, amelynek valamelyik része
  benne van az azonosítójában. Fiókonként legfeljebb 5 alkeret vehető fel.
  - **Önálló keret:** a fiók keretétől független; a modelljei tokenjei **nem** számítanak bele a fiók
    keretébe, így a fő százalék, a csoportok, a gépek és a „Fogyás időben" grafikon nélkülük értendők (a
    „Modellek" grafikonon továbbra is látszanak). Bekapcsolt tokenkeretnél saját tokenkerete van.
  - **A keret része:** a modelljei a fiók keretébe számítanak, és abból legfeljebb a megadott arányt
    használhatják (bekapcsolt tokenkeretnél: a fiók keretének ennyi százaléka a saját kerete).
- Ha a hónapban nincs olyan nap (31., vagy februárban a 30.), a reset a **hónap utolsó napjára** esik.
- Az **AI-fiók** választó azonnal, új kérés nélkül váltja a teljes dashboardot. Az utoljára választott
  fiók és a providerenként megadott hivatalos százalék a böngészőben külön-külön megmarad.
- A szín HEX kód, nem Tailwind-osztály: a Tailwind fordításkor állítja elő a CSS-t, egy Redisből
  érkező osztálynévhez nem lenne stílus. A színt a komponensek inline stílusként alkalmazzák.
- **Ismeretlen csoport:** ha egy gép olyan `groupId`-t küld, amely nincs a listán, a rendszer
  magától felveszi, véletlen (a sötét háttéren olvasható sávból húzott) színnel. A szín utólag átírható.
- **Tokenkeret:** alapból ki van kapcsolva, mert a providerek tokenben mért kerete nem ismert, csak a
  saját kijelzőjükön látható százalék. Kikapcsolva a dashboard semmit nem számol tokenkerethez: nincs
  maradék token, és a keret állását, a tempót, valamint a csoportok és gépek keretbeli részét csak a
  beírt hivatalos százalék adja (lásd lent). Bekapcsolva a korábbi működés tér vissza, a megadott
  keretekkel. A keretek kikapcsolva is tárolva maradnak, így visszakapcsoláskor megvannak.
- **Maradék tokenek:** a kapcsoló csak bekapcsolt tokenkeretnél látszik, és csak a megjelenítést érinti.
  Kikapcsolva eltűnik a „Maradt" / „Túllépés" blokk, és a keret elfogyásakor a szöveg a tokenek helyett
  azt mondja meg, mikor jön a következő reset. A százalék, az elfogyott mennyiség és a reset ideje megmarad.
- **Törlés:** csak olyan csoport törölhető, amelynek nincs tárolt jelentése. Különben a jelentései
  eltűnnének a dashboardról, a következő beküldéskor pedig a csoport új színnel térne vissza.

### API-token a Telepítés oldal másológombjához

A Beállítások panel alján megadható a `USAGE_API_TOKEN` másolata. A szerver **AES-256-GCM**-mel
titkosítja (kulcs: `TOKEN_ENCRYPTION_KEY`, értékenként friss IV, a céljához kötött AAD), és csak a
titkosított formát írja a Redisbe; a kulcs csak a szerver környezetében van. A panel sosem mutatja a
tokent, csak az állapotát: tárolva van-e, mikor mentették, és **egyezik-e a szerver `USAGE_API_TOKEN`-jével**
(ha nem, a telepítő úgyis elutasítaná).

- **Hozzáadás** azonnal ment. **Módosítás** előtt megerősítő ablak jön, és az *Igen* gomb csak
  5 másodperc után nyomható meg.
- Az **Audit** gomb görgethető listában mutatja, mikor, melyik böngészőből (böngésző, rendszer,
  User-Agent, IP-cím, a munkamenet rövid azonosítója) adták hozzá, módosították vagy kérték le a tokent.
  Az utolsó 500 esemény marad meg. A lekérés előbb kerül a naplóba, és csak utána adja ki a szerver a tokent.
- A kliensek továbbra is a `USAGE_API_TOKEN` környezeti változóval azonosítanak: a tárolt másolat csak
  a másolást szolgálja, a hitelesítésbe nem szól bele.
- Ha a `TOKEN_ENCRYPTION_KEY` hiányzik, a szekció ezt jelzi, és nem enged menteni. Ha megváltozik, a
  tárolt másolat nem fejthető vissza: add meg újra.

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
teljes keret 5%-át használta el. Ilyenkor a fő sáv és a tempóbecslés a hivatalos értékből számol, a
csoportok és a gépek „A keretből" oszlopa pedig a fenti képlet szerint osztja szét.

- **Tokenkeret nélkül** (alapbeállítás) a tokenszámok a gépek mért értékei maradnak, hiszen nincs keret,
  amelyre át lehetne váltani őket. **Üres mezővel** a dashboard a keret állását nem ismeri: csak a mért
  tokeneket és az arányokat mutatja, a fő sáv üres, és „A keretből" oszlop sem látszik.
- **Tokenkerettel** a tokenszámok is a hivatalos értékhez igazodnak; a panel kiírja a mért értéket és a
  szorzót is. **Üres mezővel** minden a gépek saját mérése és a beállított keret szerint számol.

Az érték csak a böngészőben él (`localStorage`), providerenként külön kulcson; a szerverre nem kerül
fel, és a ciklus végén magától törlődik. A tempót a dashboard a beírás időpontjára vetíti.

**Alkeretek:** a fiók alkeretei a fő mező alatt kisebb mezőt és csúszkát kapnak, az állapotukkal (ikon,
elfogyott rész, tempó) együtt. A százalék mindig az **alkeret saját keretének** százaléka, ahogy a
provider kijelzője mutatja. Ha nincs beírva:

- **a keret része** a fiók hivatalos értékéből számol, a mért arány szerint:

  ```
  alkeret állása = (fiók hivatalos %-a × az alkeret mért tokenjei / a fiók mért tokenjei) / megengedett arány
  ```

  Példa: a Claude 40%-on áll, a mért tokenek 86%-a Opus, az Opus legfeljebb 40%-ot használhat: a teljes
  keret 34,5%-a az övé, vagyis a saját keretének 86%-a fogyott el.
- **önálló keret** csak bekapcsolt tokenkeretnél becsülhető (a mért tokenjei a saját keretéhez mérve).
- Modellenkénti bontás nélkül (régi kliensek) az alkeret mért része nem ismert: ilyenkor csak a beírt
  érték számít.

### Grafikonok

Mindkét grafikon vízszintes tengelye a teljes ciklus (a fő sávval egy vonalban), a vonalak a mostani
pillanatig tartanak. A szerver a ciklust egyenletes rácson mintázza (heti ciklusnál óránként, havinál
4 óránként, plusz a mostani pillanat), és a rács minden pontján a ciklus eleje óta halmozott tokeneket
adja át; az utolsó pont pontosan a táblázatok összege.

- **Fogyás időben** (a nagy százalék alatt): csoportonként egy vonal a csoport színében, és fehér
  szaggatottal az összesített. A függőleges tengely a keret százaléka: minden mért token ugyanannyit ér,
  `hivatalos százalék / összes mért token` (tokenkerettel és üres mezővel `1 / keret`), így a szaggatott
  vonal a nagy számon ér véget, a csoportok pedig a mért tokenjeik arányában osztoznak rajta. Tokenkeret
  és hivatalos százalék nélkül nincs mihez mérni: ilyenkor a grafikon helyén rövid útmutatás áll.
- **Modellek** (az oldal alján): a kapcsolóval kiválasztott modell mért tokenjei csoportonként, a
  csoportok színében; más modell nem látszik, két csoportnál tehát két vonal. A választó a kiválasztott
  AI-fiók modelljeit sorolja fel, a legtöbbet használttal kezdve; a dátumozott buildek
  (`claude-sonnet-4-5-20250929`) a dátum nélküli névvel egy vonalba kerülnek.

Egérrel vagy (a grafikonra fókuszálva) a nyilakkal egy időpont összes értéke kiolvasható; a
„Táblázatként" lenyíló ugyanezt napokra bontva, szövegesen adja.

### A kódban: `lib/config.ts`

Ami nem a panelen van, az a `lib/config.ts` elején; a környezeti változó felülírja az ott lévő
értéket (érvénytelen érték esetén a konstans marad, és figyelmeztetés kerül a naplóba).

| Konstans | Env | Alapérték | Jelentés |
| --- | --- | --- | --- |
| `DEFAULT_USE_TOKEN_LIMITS` | – | `false` | a „Tokenkeret használata" kapcsoló **kezdőértéke** |
| `DEFAULT_LIMIT` | `WEEKLY_LIMIT` | `500000` | minden új provider tokenkeretének **kezdőértéke** (csak bekapcsolt tokenkeretnél számít) |
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
  "providers": { "deepseek": 15000, "claude": 22000, "openai": 9000 },
  "models": {
    "claude": { "claude-opus-4-5-20251101": 18000, "claude-haiku-4-5-20251001": 4000 },
    "deepseek": { "deepseek-chat": 15000 }
  },
  "days": {
    "2026-09-20": {
      "providers": { "claude": 12000, "openai": 9000 },
      "models": { "claude": { "claude-opus-4-5-20251101": 12000 } },
      "hours": { "claude": { "2026-09-20T08:00:00Z": 5000, "2026-09-20T09:00:00Z": 7000 } }
    },
    "2026-09-21": { "providers": { "deepseek": 15000, "claude": 10000 } }
  }
}
```

A `machineId` és a `groupId` 1–64 karakter: betű (ékezetes is), szám, szóköz, `.`, `_`, `-`.
A `providers` 1–20 bejegyzésből áll; minden érték nemnegatív, biztonságos egész JSON-szám. A
`timestamp` ISO 8601, zónajelöléssel. A `models` elhagyható: providerenként a tokenek modellekre
bontva (providerenként legfeljebb 20, összesen legfeljebb 60 modell; az azonosító formátuma a provideré).
Csak a `providers`-ben szereplő provider bontható, és a modellek összege nem lehet nagyobb a provider
értékénél (kisebb lehet: nem minden token köthető modellhez). A `days` is elhagyható: ugyanez a
snapshot naptári napokra bontva (`ÉÉÉÉ-HH-NN` kulcsok a ciklus időzónájában, legfeljebb 32 nap), naponként
`providers` és elhagyható `models`, ugyanazokkal a szabályokkal. Egy nap csak a `providers`-ben szereplő
providert tartalmazhatja, és egy provider napjai együtt sem lehetnek többek a teljes értékénél. A napok
elhagyható `hours` mezője providerenként az adott nap óráit adja (kulcs: az óra kezdete UTC-ben, egész
órára, és a napon belül kell lennie; naponként legfeljebb 25 óra). Egy provider órái nem lehetnek többek a
napjánál. A szerver csak a jelentés saját ciklusába eső napzáró pontokat tárolja. A válasz
`groupRegistered` és `providersRegistered` mezője jelzi az új indexbejegyzéseket.

| Kód | Jelentés |
| --- | --- |
| `201` | eltárolva |
| `200` | pontosan ez a jelentés már megvan (`"duplicate": true`): az újraküldés nem számol duplán |
| `400` | hibás JSON vagy mező (`details` felsorolja az összeset) |
| `401` | hiányzó vagy rossz token |
| `413` | 64 KB-nál nagyobb törzs |
| `500` | a szerveren nincs (elég hosszú) `USAGE_API_TOKEN` |
| `503` | a Redis nincs bekötve vagy nem elérhető: a kliens a következő órában újrapróbálja |

### `/api/settings`: a Beállítások panel végpontja

A dashboard session-sütijével hitelesít (nem a Bearer tokennel): érvényes PIN-session nélkül mindkét
metódus `401`-et ad, és semmilyen adathoz nem nyúl.

`GET` visszaadja a beállításokat és a csoportokat (`hasReports`: van-e tárolt jelentése). `PUT` törzse:

```json
{
  "period": "weekly",
  "useTokenLimits": false,
  "limits": { "claude": 500000, "deepseek": 750000, "openai": 1000000 },
  "reset": { "weekday": 1, "monthDay": 1, "hour": 0, "minute": 0 },
  "showRemaining": true,
  "hiddenProviders": ["openai"],
  "excludedProviders": { "Work": ["claude", "deepseek"] },
  "subLimits": {
    "claude": [
      { "id": "fable", "name": "Fable", "models": ["fable"], "mode": "separate", "sharePercent": 50, "limit": 400000 }
    ]
  },
  "groups": [{ "id": "Work", "color": "#3987e5" }],
  "removedGroups": ["Regi"]
}
```

A `hiddenProviders` a dashboardon nem látszó providerek listája; ha minden ismert provider benne van, a
válasz `400`. Az `excludedProviders` csoportonként azokat a providereket sorolja, amelyekbe a csoport
**nem** számít bele (a nem szereplő csoport mindenhová beszámít). A `subLimits` fiókonként az alkeretek
listája: `mode` `"separate"` (önálló keret, saját `limit` tokenkerettel) vagy `"share"` (a fiók keretének
része, legfeljebb `sharePercent` %-a); a nem használt mező is tárolódik, hogy a mód visszaváltásakor
megmaradjon. Az `id` fiókon belül egyedi (`a-z`, `0-9`, `-`), a `models` 1–10 modellazonosító-rész.

A `limits` minden ismert provider külön kerete; `"useTokenLimits": false` mellett is tárolódik, csak
nem számít. A `groups` létrehoz vagy átszínez; **a fel nem sorolt csoportok érintetlenek maradnak**
(így egy közben magától felkerült csoportot a mentés nem töröl ki). A `weekday` és a `monthDay` mindig
tárolódik, hogy a keret típusának visszaváltásakor megmaradjon a korábbi választás. A keret mezői
mind kötelezők, a `useTokenLimits`, a `showRemaining`, a `hiddenProviders`, az `excludedProviders` és a
`subLimits` is (az utóbbi három lehet üres): a `PUT` a teljes beállítást írja felül, semmit nem pótol alapértékkel. (A
Redisben lévő, a kapcsolók előtt mentett dokumentum viszont gond nélkül olvasódik: ott a hiányzó
`showRemaining` bekapcsoltat, a hiányzó `useTokenLimits` kikapcsoltat jelent, a hiányzó fióklisták
pedig azt, hogy minden provider látszik és mindenhová beszámít.)

| Kód | Jelentés |
| --- | --- |
| `200` | elmentve |
| `400` | hibás JSON vagy mező (`details` felsorolja az összeset), vagy minden provider rejtett lenne |
| `401` | nincs érvényes session |
| `403` | idegen `Origin` (a `SameSite=Lax` süti mellé második védvonal) |
| `409` | egy törlendő csoportnak van tárolt jelentése (`groups`); **semmi nem lett elmentve** |
| `413` / `415` | 16 KB-nál nagyobb, illetve nem JSON törzs |
| `503` | a Redis nincs bekötve vagy nem elérhető |

### `/api/api-token`: a tárolt token és az auditnapló

Mind a session-sütivel hitelesít, mint a `/api/settings`; session nélkül `401`, és semmihez nem nyúl.
Az írások csak azonos eredetről (`Origin`) fogadhatók el.

| Végpont | Mit csinál |
| --- | --- |
| `GET /api/api-token` | állapot: `{"status":{"state":"no_key"\|"empty"\|"unreadable"\|"stored","updatedAt","matchesServer"}}`, a token nélkül |
| `PUT /api/api-token` | `{"token":"…"}` (16–512 szóköz nélküli ASCII karakter): titkosítva menti, a naplóba `created`/`updated` kerül |
| `POST /api/api-token/reveal` | `{"token":"…"}`: előbb `revealed` bejegyzés a naplóba, csak utána a token. `404` ha nincs, `409` ha nem fejthető vissza |
| `GET /api/api-token/audit` | `{"entries":[{"at","action","browser","os","userAgent","ip","session"}],"currentSession"}`, a legfrissebb elöl |

Hiányzó vagy hibás `TOKEN_ENCRYPTION_KEY` mellett a `PUT` és a `reveal` `500`-at ad
(`encryption_key_missing`), a `GET` pedig `"state":"no_key"`-t.

### `/api/setup`: a telepítőcsomag letöltése

`GET /api/setup?os=macos|windows&mode=auto|manual&group=Work&machine=win-desktop` a Telepítés oldal
ZIP-je. A session-sütivel hitelesít, mint az oldal; session nélkül `303`-mal a `/setup` PIN-képernyőjére
küld. A `machine` üres is lehet. A csomagban lévő config a szerver saját címére mutat; éles
környezetben mindig az éles domainre (`VERCEL_PROJECT_PRODUCTION_URL`), mert a generált
`*.vercel.app` címeken a kliensek `401 Protected deployment` választ kapnának.

| Kód | Jelentés |
| --- | --- |
| `200` | `application/zip`, `Content-Disposition: attachment` |
| `303` | nincs érvényes session |
| `400` | hibás rendszer, mód, csoport vagy gépazonosító |
| `503` | a Redis nincs bekötve vagy nem elérhető |

## 6. Redis adatmodell

```
usage:settings                    STRING {"v":2,"period","useTokenLimits","limits":{…},"reset":{…},
                                         "hiddenProviders":[…],"excludedProviders":{groupId:[…]},
                                         "subLimits":{providerId:[{"id","name","models","mode",…}]},…}
usage:providers                   HASH providerId → első megjelenés (ms)
usage:events:{provider}:{group}   ZSET score = jelentés ideje; member = {"m","t","ts","b"}
                                  ("b": modellenkénti bontás, csak ha a kliens küldött)
usage:groups                      HASH groupId → {"color":"#rrggbb","ts": első megjelenés}
usage:machines                    HASH providerId:machineId → {"g","ts","t"}
usage:api-token                   STRING {"v":1,"iv","ct","tag","updatedAt"}: AES-256-GCM, a token sosem nyíltan
usage:api-token:audit             LIST a legfrissebb elöl, legfeljebb 500: {"at","a","ua","ch","pf","ip","s"}
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
- **Telepítés:** a `/setup` oldal és a `/api/setup` letöltés is a PIN-session mögött van. A csomag nem
  tartalmaz titkot: a tokent a telepítő kéri be rejtetten, a szerveren ellenőrzi, és csak a gép saját
  configjába írja (macOS-en 600-as joggal, Windowson a felhasználói profil alá).
- **Tárolt token:** a Beállítások panelen megadott másolat AES-256-GCM-mel titkosítva kerül a Redisbe, a
  kulcs (`TOKEN_ENCRYPTION_KEY`) csak a szerveren van. A token nem kerül a HTML-be: a *Token másolása*
  gomb `POST`-tal kéri le (`Cache-Control: no-store`), és minden lekérés, mentés a böngésző adataival az
  auditnaplóba kerül, mielőtt a szerver válaszolna. Csere előtt megerősítés kell, 5 másodperces várakozással.
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
