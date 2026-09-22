# Projekt Célok: Multi-provider Usage Tracker

## 1. Fő Célkitűzés
Egy pehelysúlyú, saját hosztolású statisztikai rendszer, amely több számítógépről egyszerre gyűjti,
aggregálja és vizualizálja több AI-szolgáltató vagy fiók (például Claude, DeepSeek és OpenAI)
tokenhasználatát. A provider külön dimenzió a gép és a Work/Personal jellegű csoport mellett.

## 2. Infrastruktúra és Architektúra Célok
*   **Környezet:** Next.js (App Router) alkalmazás Vercel-en hosztolva, Vercel MCP támogatással.
*   **Domain:** A projekt éles URL-je: `usageratio.snktibor.hu`
*   **Adattárolás:** Vercel KV (Redis) használata a gyors olvasáshoz/íráshoz és a heti ciklusok könnyű szűréséhez.

## 3. Kliensoldali Célok (Adatgyűjtés)
*   **Két futtatási mód:** Az automatikus Bash/PowerShell kliensek teljesen csendben fussanak; a manuális kliensek adjanak egyértelmű konzolos eredményt.
*   **Erőforráskímélő működés:** Az automatikus kliensek minimális CPU és RAM használattal, teljesen láthatatlanul (rejtett ablakkal) fussanak a háttérben.
*   **Ütemezés:** Beépített OS eszközökkel (Cron, Task Scheduler) automatizált, óránkénti futás.
*   **Adatforrás:** A Bash és PowerShell kliens a `ccusage daily` gépi JSON-kimenetét dolgozza fel, és minden felismert providert továbbít.
*   **Szabványosított Payload:** A kliensek a következő JSON struktúrát küldik a szervernek:
    `{ "machineId": "string", "groupId": "string", "providers": { "claude": 0, "deepseek": 0 }, "timestamp": "ISO 8601 string" }`

## 4. Backend Célok (API)
*   **Megbízható Adatfogadás:** Dedikált API végpont (`/api/usage/route.ts`) létrehozása, amely fogadja, validálja és a Vercel KV-ba menti a kliensek POST kéréseit.
*   **Biztonság:** Az API végpont szigorú Bearer token alapú autentikációt igényel, hogy jogosulatlan adatok ne kerüljenek az adatbázisba.

## 5. Frontend és Üzleti Logika Célok (Dashboard)
*   **Heti Reset Ciklus:** A rendszer automatikusan számolja az aktuális periódust (pl. minden hétfő 00:00-tól). A Dashboard **kizárólag** a legutóbbi reset óta eltelt időszak beérkezett adatait aggregálja.
*   **Csoportosított Nézet:** A beérkező tokenek automatikus összegzése `groupId` alapján.
*   **Kapacitáskövetés:** Providerenként külön beállítható keret és az ahhoz tartozó Progress Bar.
*   **Fiókváltás:** A provider választása kliensoldalon, új hálózati kérés nélkül frissíti a teljes dashboardot.
*   **Arányok Vizualizációja:** A Dashboard mutassa meg a csoportok (pl. Work vs. Personal) százalékos arányát a teljes heti fogyasztáson belül, illetve a gépek egyedi hozzájárulását.
*   **Design:** Modern, letisztult, sötét témájú felhasználói felület Tailwind CSS használatával.

## 6. Biztonsági Célok (UI)
*   **PIN kódos védelem:** A teljes Dashboard egy egyszerű, 5 jegyű PIN kód mögé van rejtve.
*   **Szerveroldali Validáció:** A PIN kódot a szerver ellenőrzi egy környezeti változó (`DASHBOARD_PIN`) alapján. Helytelen kód esetén az API és a felület semmilyen használati adatot nem szolgáltathat ki.
