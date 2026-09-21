# Projekt Célok: Codex Usage Tracker (goals.md)

## 1. Fő Célkitűzés
Egy pehelysúlyú (lightweight), saját hosztolású statisztikai rendszer felépítése, amely 3 különböző számítógépről (1 Mac, 2 Windows) gyűjti, aggregálja és vizualizálja a "Codex" AI heti tokenhasználatát. A rendszer célja a heti keret (Max limit) nyomon követése, csoportokba (pl. Work, Personal) rendezve, egy központi Dashboardon.

## 2. Infrastruktúra és Architektúra Célok
*   **Környezet:** Next.js (App Router) alkalmazás Vercel-en hosztolva, Vercel MCP támogatással.
*   **Domain:** A projekt éles URL-je: `usageratio.snktibor.hu`
*   **Adattárolás:** Vercel KV (Redis) használata a gyors olvasáshoz/íráshoz és a heti ciklusok könnyű szűréséhez.

## 3. Kliensoldali Célok (Adatgyűjtés)
*   **Erőforráskímélő működés:** A klienseken futó szkriptek (Bash a Mac-en, PowerShell a Windows-on) minimális CPU és RAM használattal, teljesen láthatatlanul (rejtett ablakkal) fussanak a háttérben.
*   **Ütemezés:** Beépített OS eszközökkel (Cron, Task Scheduler) automatizált, óránkénti futás.
*   **Modularitás:** A tényleges Codex token kiolvasó logika NEM része ennek a fázisnak. A szkriptekben egyértelmű placeholder (`[TODO: INSERT CODEX TOKEN READ LOGIC HERE]`) biztosítja, hogy a kiolvasó blokk később cserélhető/injektálható legyen.
*   **Szabványosított Payload:** A kliensek a következő JSON struktúrát küldik a szervernek:
    `{ "machineId": "string", "groupId": "string", "tokens": number, "timestamp": "ISO 8601 string" }`

## 4. Backend Célok (API)
*   **Megbízható Adatfogadás:** Dedikált API végpont (`/api/usage/route.ts`) létrehozása, amely fogadja, validálja és a Vercel KV-ba menti a kliensek POST kéréseit.
*   **Biztonság:** Az API végpont szigorú Bearer token alapú autentikációt igényel, hogy jogosulatlan adatok ne kerüljenek az adatbázisba.

## 5. Frontend és Üzleti Logika Célok (Dashboard)
*   **Heti Reset Ciklus:** A rendszer automatikusan számolja az aktuális periódust (pl. minden hétfő 00:00-tól). A Dashboard **kizárólag** a legutóbbi reset óta eltelt időszak beérkezett adatait aggregálja.
*   **Csoportosított Nézet:** A beérkező tokenek automatikus összegzése `groupId` alapján.
*   **Kapacitáskövetés:** Egy globális Progress Bar, amely vizuálisan megmutatja az összesített használatot egy fix (környezeti változóból jövő vagy hardkódolt) heti limithez viszonyítva.
*   **Arányok Vizualizációja:** A Dashboard mutassa meg a csoportok (pl. Work vs. Personal) százalékos arányát a teljes heti fogyasztáson belül, illetve a gépek egyedi hozzájárulását.
*   **Design:** Modern, letisztult, sötét témájú felhasználói felület Tailwind CSS használatával.

## 6. Biztonsági Célok (UI)
*   **PIN kódos védelem:** A teljes Dashboard egy egyszerű, 5 jegyű PIN kód mögé van rejtve.
*   **Szerveroldali Validáció:** A PIN kódot a szerver ellenőrzi egy környezeti változó (`DASHBOARD_PIN`) alapján. Helytelen kód esetén az API és a felület semmilyen használati adatot nem szolgáltathat ki.