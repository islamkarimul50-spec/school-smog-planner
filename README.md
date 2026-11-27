# School Smog Planner

> **Practical Question:** *“Given today’s air quality, our school start time, our budget, and the travel options we actually have, what should our family do this morning?”*

**School Smog Planner** is a full-stack TypeScript web application built for **PromptWars Virtual Challenge 6**. It helps parents and school communities navigate severe winter smog and urban air pollution by combining deterministic constraint enforcement in code with grounded Gemini AI explanations and a privacy-safe school corridor action board.

---

## 1. Chosen Users

- **Primary users:** Parents and caregivers of school-aged children in smog-affected metro corridors (such as Delhi-NCR during winter inversion episodes) balancing tight morning bells (`08:00`), fixed daily budgets, real transport availability, and child respiratory health.
- **Secondary users:** School PTAs, parent carpool coordinators, and school transport leads seeking idle-free drop-off zones and clean-air morning alternatives without exposing student or household details.

---

## 2. Approach & Architecture

The application strictly separates **external services**, **deterministic decision logic**, and **presentation**:

| Layer | Directory / Files | Responsibility |
| :--- | :--- | :--- |
| **Shared Types & Rules** | [`src/shared/types.ts`](src/shared/types.ts), [`src/shared/constants.ts`](src/shared/constants.ts), [`src/shared/airQualityUtils.ts`](src/shared/airQualityUtils.ts) | Explicit typed units (`µg/m³`, `minutes`, `INR`/`USD`), 2024 US EPA PM2.5 AQI breakpoints, staleness checks, and single-source travel/IAQ cost & emission tables. |
| **Validation & Privacy Guard** | [`src/shared/validation.ts`](src/shared/validation.ts) | Zod bounds validation for household inputs, manual PM2.5 entries, chat payloads, and community PII blocking (`detectCommunityPii`). |
| **Decision Engine** | [`src/shared/decisionEngine.ts`](src/shared/decisionEngine.ts) | Pure deterministic solver (`buildMorningPlan`, `evaluateBusAvailability`, `computePlanDiff`) enforcing availability, budget, timing, and PM2.5 safety limits before AI runs. |
| **External Services** | [`src/server/services/airQualityService.ts`](src/server/services/airQualityService.ts), [`src/server/services/geminiService.ts`](src/server/services/geminiService.ts), [`src/server/services/communityStore.ts`](src/server/services/communityStore.ts) | Server-side Open-Meteo client with 15-min AQ TTL caching & timeout handling, server-only `@google/genai` client with labeled deterministic fallback, and in-memory notice store. |
| **HTTP API & Security** | [`src/server/app.ts`](src/server/app.ts), [`src/server/routes/`](src/server/routes/) | Express routes (`/api/bootstrap`, `/api/air-quality`, `/api/plan`, `/api/chat`, `/api/community`), 64 KB payload limit, rate limiting, security headers, and static production serving. |
| **Presentation UI** | [`src/client/App.tsx`](src/client/App.tsx), [`src/client/components/`](src/client/components/) | Keyboard-accessible React UI showing source/timestamp/units, all three recommendation cards, explicit emissions vs. personal exposure split, visible assumptions, plan diff, coach Q&A, and community board. |

### Key Design Decisions

1. **Deterministic constraints in code; Gemini explains and answers follow-ups:** Travel availability, daily budget, morning departure windows, and child active-commute PM2.5 caps are evaluated strictly in `decisionEngine.ts`. Gemini cannot invent feasible options or bypass constraints.
2. **Emissions vs. Personal Exposure distinction:** Every plan separates *community/tailpipe emissions* (`kg CO2e/round-trip`) from what the child *personally inhales* (e.g., noting that a shared school bus replaces solo car trips yet still exposes riders to roadway PM2.5 unless cabin windows stay shut and a fitted N95/KF94 mask is worn).
3. **Transparent numbers:** Numerical estimates appear alongside collapsible/visible formulas, factors, and assumptions.
4. **No silent fake data or key leakage:** `GEMINI_API_KEY` stays strictly on the server. When live air quality fails, the UI alerts the parent and offers clearly labeled sample datasets or manual entry. When Gemini is unavailable, explanations and chat responses are clearly badged `Source: Deterministic Fallback (Gemini Unavailable)`.

---

## 3. Decision Logic & Bus Availability Rule Trace

### Journey from Input to Result
1. User inputs are validated on both client and server via `HouseholdInputSchema` (`src/shared/validation.ts`), verifying `earliestReadyTime < schoolStartTime`, `commuteDurationMinutes` (`5–180`), and `dailyBudget` (`0–100,000`).
2. `buildMorningPlan` (`src/shared/decisionEngine.ts`) computes `availableWindowMinutes = schoolStartMinutes - earliestReadyMinutes` and normalizes budget to INR (`convertCurrencyToInr`).
3. `evaluateAllTravelOptions` evaluates all five modes (`schoolBus`, `metroOrPublicTransit`, `carpool`, `walkOrCycle`, `privateCar`) through one shared rule path (`checkTravelConstraints`).
4. **Exact function handling bus availability:**
   - **Function:** [`evaluateBusAvailability`](src/shared/decisionEngine.ts) in `src/shared/decisionEngine.ts`.
   - It checks `input.travelOptions.schoolBus`, bus daily cost (`₹60/day`) against `dailyBudgetInr`, and door-to-door time (`round(commuteDurationMinutes × 1.15) + 5 min`) against `availableWindowMinutes`.
   - **Regression tests catching breakage:**
     - `evaluateBusAvailability accepts Shared School Bus when available, affordable, and on time` in [`tests/decisionEngine.test.ts`](tests/decisionEngine.test.ts)
     - `selects Shared School Bus when available, then switches cleanly when ONLY bus availability changes to false` in [`tests/decisionEngine.test.ts`](tests/decisionEngine.test.ts)
5. Feasible modes are ranked by `smogPriority` when `PM2.5 > 55.4 µg/m³` (favoring enclosed high-consolidation transit) or `cleanAirPriority` when `PM2.5 <= 55.4 µg/m³` (favoring zero-emission walking/cycling within duration caps).
6. If zero travel modes pass all rules, `routineStatus` becomes `'NO_FEASIBLE_OPTION'`, listing each mode's disqualification reason and actionable constraint-change prompts asking the parent which constraint can change.
7. Remaining budget (`dailyBudgetInr - allocatedTravelCostInr`) and home setup (`homePurifier`, `homeVentilation`) determine the **Indoor Air Quality** recommendation, while active transit/smog conditions shape the **Sustainable Community Alternative**.
8. `computePlanDiff` compares the previous plan snapshot against the new plan to surface **what changed**, **what stayed relevant**, and **why**.

---

## 4. Setup & Verification Commands

### Prerequisites
- **Node.js** `v22+` (verified on `v24.22.3`) and **npm** `10+`

### Installation
```bash
npm install
```

### Optional Environment Configuration
Copy `.env.example` to `.env` if you want live Gemini responses (omit to verify deterministic fallback mode):
```bash
cp .env.example .env
# Edit .env and set GEMINI_API_KEY=... (never commit .env)
```

### Development
```bash
npm run dev
```
- Frontend dev server: `http://localhost:5173` (proxies `/api/*` to Express on `http://localhost:3001`).

### Type Check, Tests, and Production Build
```bash
npm run typecheck
npm test
npm run build
NODE_ENV=production npm start
```
Then open `http://localhost:3000` (or the configured `PORT`).

---

## 5. Data Sources

- **Live Air Quality & Geocoding:** [Open-Meteo Geocoding API](https://geocoding-api.open-meteo.com/v1/search) and [Open-Meteo Air Quality API](https://air-quality-api.open-meteo.com/v1/air-quality) (`current=pm2_5,pm10,us_aqi`, units `µg/m³` and `US AQI`). Query alias normalization maps `Delhi-NCR` to `New Delhi`. Responses are cached for 15 minutes on the server and flagged stale if older than 3 hours.
- **AQI Category Classification:** Revised May 2024 US EPA 24-hour `PM2.5` AQI breakpoints implemented in [`src/shared/airQualityUtils.ts`](src/shared/airQualityUtils.ts).
- **Sample & Manual Fallbacks:** Explicitly labeled sample presets (`Delhi-NCR Winter Inversion 245 µg/m³`, `Moderate Urban 38 µg/m³`, `Clean Morning 8.5 µg/m³`) and parent-entered manual `PM2.5` readings (`POST /api/air-quality/manual`).
- **Generative AI:** Google Gemini via the official `@google/genai` SDK (defaults to `gemini-3.5-flash-lite`, configurable via `GEMINI_MODEL`), executed strictly server-side with a 10-second timeout and deterministic labeled fallback.

---

## 6. Assumptions (Visible in App & Constants)

All baseline constants live in [`src/shared/constants.ts`](src/shared/constants.ts):

- **Baseline urban morning speed:** `24 km/h` (used solely to estimate one-way route distance `km` from `commuteDurationMinutes` for CO₂e comparisons).
- **Travel mode round-trip costs & time formulas:**
  - `Shared School Bus`: `₹60/day`, `duration × 1.15 + 5 min`, `0.028 kg CO2e/student-km`
  - `Metro / Public Transit + Covered Feeder`: `₹90/day`, `duration × 1.35 + 8 min`, `0.025 kg CO2e/student-km`
  - `3-Family School Carpool`: `₹85/day`, `duration × 1.15 + 5 min`, `0.06 kg CO2e/student-km`
  - `Walk / Cycle`: `₹0/day`, `duration × 1.8 + 2 min`, `0 kg CO2e/student-km`
  - `Private Car / Solo Cab`: `₹220/day`, `duration × 1.0 + 3 min`, `0.18 kg CO2e/student-km`
- **Active-commute safety limits:** `Walk / Cycle` is blocked above `90.0 µg/m³` PM2.5 (`55.4 µg/m³` when respiratory sensitivity is checked) or above `25 min` door-to-door along urban roads.
- **IAQ daily amortized cost estimates:** Zero-cost draft sealing (`₹0/day`), DIY box-fan MERV-13 filter upkeep (`₹35/day` over ~90 winter days), Portable HEPA operation (`₹30/day` + `~0.03 kg CO2e` for 1-hour pre-school morning run at `35W`).
- **Currency conversion (when USD selected):** `1 USD = 84 INR`.

---

## 7. Demo Outline (Under 4 Minutes)

1. **0:00–0:45 | Practical Problem & Live AQ:** Open `http://localhost:3000`. Show the Air Quality Snapshot for `Delhi-NCR` (source, timestamp, `µg/m³`, US AQI). Highlight the core practical question.
2. **0:45–1:45 | Acceptance Case 1 (School Bus = Yes):** Set `Delhi-NCR`, `08:00` school start, `07:00` earliest departure, `25 min` commute, `₹150/day` budget, all travel modes checked. Click **Generate Morning Plan**. Point out all 3 cards (Routine, IAQ, Sustainable Alternative), the emissions vs. personal exposure split on School Bus, and collapsible assumptions.
3. **1:45–2:45 | Constraint Change & Gemini Follow-Up (Bus = No):** Uncheck **only** `Shared School Bus` and click **Update Morning Plan**. Show the **Plan Comparison Diff** (`What Changed`: School Bus → Metro + Covered Feeder; `What Stayed Relevant`: Indoor Air Quality & Community Alternative; `Why`). Ask Coach: **“Why did my travel plan change?”** and verify the reply cites `School Bus = No` and latest inputs.
4. **2:45–3:30 | Edge Case (No Feasible Option) & Privacy-Safe Community Action:** Uncheck `Metro / Public Transit` and `Carpool` (leaving only `Walk / Cycle` blocked by smog and `Private Car` at `₹220/day > ₹150` budget). Click **Update Morning Plan** to show `[CONFLICT] No Feasible Travel Option` asking which constraint can change. Briefly demonstrate the Community Action Board blocking a test phone number/house address while posting a safe corridor no-idling notice.
