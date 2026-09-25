# Project Goals: Multi-provider Usage Tracker

## 1. Main Objective
A lightweight, self-hosted statistics system that collects, aggregates, and visualizes the token
usage of multiple AI providers or accounts (for example Claude, DeepSeek, and OpenAI) from several
computers at once. The provider is a separate dimension alongside the machine and the Work/Personal
type group.

## 2. Infrastructure and Architecture Goals
*   **Environment:** A Next.js (App Router) app hosted on Vercel, with Vercel MCP support.
*   **Domain:** The project's production URL is your own custom domain, e.g. `usageratio.example.com`.
*   **Data storage:** Vercel KV (Redis) for fast read/write and easy filtering of weekly cycles.

## 3. Client-side Goals (Data Collection)
*   **Two run modes:** The automatic Bash/PowerShell clients run completely silently; the manual
    clients give a clear console result.
*   **Resource-friendly operation:** The automatic clients run with minimal CPU and RAM usage,
    completely invisibly (hidden window) in the background.
*   **Scheduling:** Automated, hourly runs using built-in OS tools (Cron, Task Scheduler).
*   **Data source:** The Bash and PowerShell client processes the machine's `ccusage daily` JSON
    output, and forwards every provider it recognizes.
*   **Standardized payload:** The clients send the following JSON structure to the server:
    `{ "machineId": "string", "groupId": "string", "providers": { "claude": 0, "deepseek": 0 }, "timestamp": "ISO 8601 string" }`

## 4. Backend Goals (API)
*   **Reliable data ingestion:** A dedicated API endpoint (`/api/usage/route.ts`) that receives,
    validates, and saves the clients' POST requests to Vercel KV.
*   **Security:** The API endpoint requires strict Bearer-token authentication, so unauthorized data
    can't reach the database.

## 5. Frontend and Business Logic Goals (Dashboard)
*   **Weekly reset cycle:** The system automatically computes the current period (e.g. every Monday
    from 00:00). The dashboard aggregates **only** the data received since the most recent reset.
*   **Grouped view:** Automatic summing of incoming tokens by `groupId`.
*   **Capacity tracking:** A separately configurable budget per provider, with a matching progress bar.
*   **Account switching:** Choosing the provider client-side updates the whole dashboard without a new
    network request.
*   **Ratio visualization:** The dashboard shows the groups' (e.g. Work vs. Personal) percentage share
    of total weekly consumption, as well as each machine's individual contribution.
*   **Design:** A modern, clean, dark-themed UI using Tailwind CSS.

## 6. Security Goals (UI)
*   **PIN code protection:** The whole dashboard is hidden behind a simple, 5-digit PIN code.
*   **Server-side validation:** The server checks the PIN code against an environment variable
    (`DASHBOARD_PIN`). On a wrong code, neither the API nor the UI serves any usage data.
