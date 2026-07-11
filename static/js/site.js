/* ============================================================
   Bitcoin Retirement Calculator
   Monthly sufficiency engine + withdrawal strategies
   ------------------------------------------------------------
   What this file now does that it didn't before:
     - Simulates month-by-month: DCA accumulation -> retirement
       drawdown -> checks whether the stack survives to life
       expectancy (the real "Yes / No", not a hardcoded value).
     - BTC holdings actually rise (buying) and fall (selling),
       so the table + chart reflect coins sold.
     - Price is its own series, independent of holdings, so a
       variable stack no longer corrupts the forecast.
     - Withdrawal strategy dropdown: Optimized / Conservative /
       Cyclical (built so more strategies slot in cleanly).
   ============================================================ */

// Register the annotation plugin (loaded in HTML; available for future use)
Chart.register(window['chartjs-plugin-annotation']);

/* ----------------------------------------------------------------
   MODEL CONSTANTS
---------------------------------------------------------------- */
const GENESIS_BLOCK_DATE = new Date("2009-01-03T00:00:00Z");
const POWER_LAW_A = Math.pow(10, -16.493);
const POWER_LAW_N = 5.68;

// Saylor scenario target prices, assumed reached by SAYLOR_TARGET_YEAR.
const SAYLOR_TARGETS = { "0": 3_000_000, "1": 13_200_000, "2": 49_000_000 };
const SAYLOR_TARGET_YEAR = 2045;

// Cyclical strategy: sell once every N years.
// NOTE: on a smooth (monotonic) price path this is deterministically
// *worse* than Optimized, because you sell ahead of need at a lower price.
// It only starts to win once we add a cyclical / volatile price model
// with peaks to sell into. Kept here so the hook exists.
const CYCLE_YEARS = 4;

// Cash held by Conservative/Cyclical earns this nominal annual yield.
// 0 = idle cash (loses purchasing power to inflation, which is the honest
// worst case). Bump this if you want to model a money-market / T-bill yield.
const CASH_ANNUAL_YIELD = 0.0;

/* Expense convention --------------------------------------------------
   false -> the entered expense is in the dollars of your RETIREMENT YEAR
            and grows by inflation each year DURING retirement.
            (This matches the original site's on-page explanation.)
   true  -> the entered expense is in TODAY'S dollars and is inflated
            continuously from now through end of life.
   Flip this one line to switch conventions.                            */
const EXPENSES_IN_TODAYS_DOLLARS = false;

/* ----------------------------------------------------------------
   LIVE PRICE
---------------------------------------------------------------- */
async function fetchCurrentBtcPrice() {
    try {
        const response = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
        );
        const data = await response.json();
        return data.bitcoin.usd;
    } catch (error) {
        console.error('Failed to fetch BTC price:', error);
        return null; // falls back to whatever is in the BTC price field
    }
}

/* ----------------------------------------------------------------
   SMALL HELPERS
---------------------------------------------------------------- */
function stripCommas(s) { return (s || "").toString().replace(/,/g, ""); }
function getVal(id) { const el = document.getElementById(id); return el ? el.value : ""; }
function fmtUSD(v) {
    return (v || 0).toLocaleString(undefined, {
        style: "currency", currency: "USD", maximumFractionDigits: 0,
    });
}
function daysSinceGenesis(date) {
    return Math.floor((date - GENESIS_BLOCK_DATE) / 86400000);
}

// Read the user-entered CAGR for the Linear / custom-CAGR model.
// This field is a PERCENTAGE: "15" and "15%" both mean 15% (0.15).
// (Note: "0.15" now means 0.15%, not 15% — type whole percents.)
function readUserCagr() {
    const el = document.getElementById("updated-cagr");
    const raw = (el ? el.value : "").toString().trim().replace('%', '');
    const parsed = parseFloat(raw);
    return isNaN(parsed) ? 0 : parsed / 100;
}

/* ----------------------------------------------------------------
   PRICE FORECAST
---------------------------------------------------------------- */
function getAnnualCagr(predictionModel, currentBtcPrice) {
    const currentYear = new Date().getFullYear();
    const yearsToTarget = SAYLOR_TARGET_YEAR - currentYear;

    switch (predictionModel) {
        case "0": // Bear
        case "1": // Base
        case "2": { // Bull
            const target = SAYLOR_TARGETS[predictionModel];
            return yearsToTarget > 0
                ? Math.pow(target / currentBtcPrice, 1 / yearsToTarget) - 1
                : 0;
        }
        case "4": // "Linear Growth" -> user-supplied CAGR.
            // NOTE: this actually COMPOUNDS, so it's exponential, not linear.
            // Label is preserved for now; rename when we revisit models.
            return readUserCagr();
        case "5": // "Exponential Growth" -> currently undefined in the original;
            // it silently fell through to Base. Behavior preserved, FLAGGED.
            return getAnnualCagr("1", currentBtcPrice);
        case "3": // Power law -> handled per-month, no single CAGR.
        default:
            return null;
    }
}

// Build a monthly price series from now (m=0) to life expectancy.
function buildMonthlyPrices(currentAge, lifeExpectancyAge, currentBtcPrice, predictionModel) {
    const totalMonths = Math.max(0, Math.round((lifeExpectancyAge - currentAge) * 12));
    const prices = [];
    const now = new Date();

    if (predictionModel === "3") {
        // Power law: price is a function of days since the genesis block.
        for (let m = 0; m <= totalMonths; m++) {
            const d = new Date(now.getFullYear(), now.getMonth() + m, now.getDate());
            prices.push(POWER_LAW_A * Math.pow(daysSinceGenesis(d), POWER_LAW_N));
        }
    } else {
        const annualCagr = getAnnualCagr(predictionModel, currentBtcPrice) || 0;
        const monthlyGrowth = Math.pow(1 + annualCagr, 1 / 12) - 1;
        for (let m = 0; m <= totalMonths; m++) {
            prices.push(currentBtcPrice * Math.pow(1 + monthlyGrowth, m));
        }
    }
    return prices;
}

/* ----------------------------------------------------------------
   THE SIMULATION ENGINE (monthly)
---------------------------------------------------------------- */
function runSimulation(p, precomputedPrices) {
    // The price path depends only on current age, life expectancy, current
    // price and model — NOT on retirement age — so the solver can build it
    // once and hand the same array to every candidate age.
    const prices = precomputedPrices || buildMonthlyPrices(
        p.currentAge, p.lifeExpectancyAge, p.currentBtcPrice, p.predictionModel
    );
    const totalMonths = prices.length - 1;
    const retirementMonth = Math.max(0, Math.round((p.retirementAge - p.currentAge) * 12));

    const monthlyInflationToday = Math.pow(1 + p.annualInflation, 1 / 12) - 1;
    const monthlyCashYield = Math.pow(1 + CASH_ANNUAL_YIELD, 1 / 12) - 1;

    // Nominal monthly expense at month m (0 before retirement).
    function expenseAt(m) {
        if (m < retirementMonth) return 0;
        if (EXPENSES_IN_TODAYS_DOLLARS) {
            return p.baseMonthlyExpense * Math.pow(1 + monthlyInflationToday, m);
        }
        const yearsIntoRetirement = Math.floor((m - retirementMonth) / 12);
        return p.baseMonthlyExpense * Math.pow(1 + p.annualInflation, yearsIntoRetirement);
    }

    let btc = p.btcStack;
    let cash = 0;
    let depletedMonth = null;
    let nextSellMonth = retirementMonth; // cyclical bookkeeping
    const monthly = [];

    for (let m = 0; m <= totalMonths; m++) {
        const price = prices[m];
        const retired = m >= retirementMonth;
        const income = expenseAt(m); // this month's withdrawal (0 before retirement)

        // Cash earns yield (no-op when yield = 0).
        if (cash > 0 && monthlyCashYield !== 0) cash *= (1 + monthlyCashYield);

        // --- Accumulation: dollar-cost average until retirement ---
        if (!retired && p.monthlyContribution > 0 && price > 0) {
            btc += p.monthlyContribution / price;
        }

        // --- Drawdown: fund expenses in retirement ---
        if (retired) {
            const need = income;

            if (p.sellStrategy === "conservative") {
                // Liquidate the entire stack to cash at retirement, spend from cash.
                if (m === retirementMonth) { cash += btc * price; btc = 0; }
                if (cash >= need) cash -= need;
                else { cash = 0; if (depletedMonth === null) depletedMonth = m; }

            } else if (p.sellStrategy === "cyclical") {
                // Every CYCLE_YEARS, sell enough to pre-fund the coming window into cash.
                if (m >= nextSellMonth && btc > 0) {
                    const windowEnd = Math.min(totalMonths, m + CYCLE_YEARS * 12 - 1);
                    let windowNeed = 0;
                    for (let k = m; k <= windowEnd; k++) windowNeed += expenseAt(k);
                    const raise = Math.max(0, windowNeed - cash);
                    const btcToSell = Math.min(btc, raise / price);
                    cash += btcToSell * price;
                    btc -= btcToSell;
                    nextSellMonth = m + CYCLE_YEARS * 12;
                }
                if (cash >= need) {
                    cash -= need;
                } else {
                    // Cash ran short mid-window: emergency top-up from any BTC left.
                    const shortfall = need - cash;
                    const btcToSell = Math.min(btc, shortfall / price);
                    cash += btcToSell * price;
                    btc -= btcToSell;
                    if (cash >= need) cash -= need;
                    else { cash = 0; if (depletedMonth === null) depletedMonth = m; }
                }

            } else {
                // OPTIMIZED (default): sell exactly what's needed, each month.
                const btcToSell = need / price;
                if (btc >= btcToSell) btc -= btcToSell;
                else { btc = 0; if (depletedMonth === null) depletedMonth = m; }
            }
        }

        monthly.push({
            m,
            age: p.currentAge + m / 12,
            price,
            btc,
            cash,
            income,
            portfolioValue: btc * price + cash,
            retired,
        });
    }

    return {
        monthly,
        sufficient: depletedMonth === null,
        depletionAge: depletedMonth === null ? null : p.currentAge + depletedMonth / 12,
        retirementMonth,
    };
}

/* ----------------------------------------------------------------
   REVERSE SOLVER: earliest age you could retire
   Holds every input fixed except retirement age, then finds the
   lowest age whose plan still survives to life expectancy.
   Sufficiency is monotonic in retirement age (later is always
   easier), so the first "Yes" scanning upward is the earliest.
---------------------------------------------------------------- */
function findEarliestRetirementAge(p, precomputedPrices) {
    const prices = precomputedPrices || buildMonthlyPrices(
        p.currentAge, p.lifeExpectancyAge, p.currentBtcPrice, p.predictionModel
    );
    // Cap at lifeExpectancy - 1 so we never report "retire the year you die"
    // (a 0-month retirement is trivially, meaninglessly "sufficient").
    for (let age = p.currentAge; age <= p.lifeExpectancyAge - 1; age++) {
        const sim = runSimulation({ ...p, retirementAge: age }, prices);
        if (sim.sufficient) return age;
    }
    return null; // not achievable with these inputs
}

/* ----------------------------------------------------------------
   AGGREGATE MONTHLY -> ANNUAL ROWS (for table + chart)
---------------------------------------------------------------- */
function aggregateAnnual(sim, currentYear) {
    const monthly = sim.monthly;
    const totalMonths = monthly.length - 1;
    const years = Math.floor(totalMonths / 12);
    const rows = [];
    for (let y = 0; y <= years; y++) {
        const snap = monthly[Math.min(y * 12, totalMonths)];
        rows.push({
            year: currentYear + y,
            age: Math.round(snap.age),
            price: snap.price,
            btc: snap.btc,
            income: snap.income,
            value: snap.portfolioValue,
        });
    }
    return rows;
}

/* ----------------------------------------------------------------
   CAGR FIELD (isolated DOM side effects, cleans up on model switch)
---------------------------------------------------------------- */
function updateCagrField(predictionModel, currentBtcPrice) {
    const el = document.getElementById("updated-cagr");
    if (!el) return;
    const label = el.parentElement ? el.parentElement.querySelector('span') : null;

    if (predictionModel === "4") {
        el.removeAttribute('disabled');
        el.style.outline = "2px solid rgb(247, 147, 26)";
        if (label) label.textContent = 'CAGR to use';
        // leave the user's typed value alone
    } else {
        el.setAttribute('disabled', 'disabled');
        el.style.outline = "";
        if (label) label.textContent = 'Updated CAGR';
        if (predictionModel === "3") {
            el.value = "Variable";
        } else {
            const cagr = getAnnualCagr(predictionModel, currentBtcPrice);
            el.value = cagr !== null ? (cagr * 100).toFixed(2) + "%" : "";
        }
    }
}

/* ----------------------------------------------------------------
   RENDER: stat cards + table
---------------------------------------------------------------- */
function renderTable(rows, retirementAge, sim, btcStack, currentBtcPrice) {
    // Current portfolio value (today, at the real current price)
    const pv = document.getElementById("portfolio-value");
    if (pv) pv.textContent = Math.round(currentBtcPrice * btcStack).toLocaleString();

    // Portfolio value at retirement
    const retSnap = sim.monthly[sim.retirementMonth] || sim.monthly[sim.monthly.length - 1];
    const rv = document.getElementById("retirement-value");
    if (rv) rv.textContent = fmtUSD(retSnap ? retSnap.portfolioValue : 0);

    // Update the "at age N" label in the card
    const retAgeSpan = document.getElementsByName('retirement-age')[0];
    if (retAgeSpan) retAgeSpan.textContent = retirementAge;

    // Build the detailed table
    const tbody = document.querySelector("#calculation-outputs tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    for (const r of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td></td>
            <td>${r.year}</td>
            <td>${r.age}</td>
            <td>${fmtUSD(r.price)}</td>
            <td>${r.btc.toFixed(4)}</td>
            <td>${fmtUSD(r.value)}</td>
            <td>${r.income > 0 ? fmtUSD(r.income) : '—'}</td>`;
        if (r.age === retirementAge) tr.classList.add('retirement-row');
        tbody.appendChild(tr);
    }
}

/* ----------------------------------------------------------------
   RENDER: the real Yes / No verdict
---------------------------------------------------------------- */
function renderVerdict(sim, lifeExpectancyAge) {
    const verdict = document.getElementById("retirement-verdict");
    const note = document.getElementById("verdict-note");
    if (!verdict) return;

    if (sim.sufficient) {
        verdict.textContent = "Yes";
        verdict.classList.remove("verdict-no");
        verdict.classList.add("verdict-yes");
        if (note) note.textContent = `Funds last through age ${lifeExpectancyAge}.`;
    } else {
        verdict.textContent = "No";
        verdict.classList.remove("verdict-yes");
        verdict.classList.add("verdict-no");
        if (note) note.textContent = `Runs out around age ${Math.floor(sim.depletionAge)}.`;
    }
}

/* ----------------------------------------------------------------
   RENDER: earliest possible retirement age (with a one-click jump)
---------------------------------------------------------------- */
function renderEarliest(earliestAge) {
    const label = document.getElementById("earliest-label");
    const btn = document.getElementById("earliest-retire-btn");
    if (!label || !btn) return;

    if (earliestAge === null) {
        label.textContent =
            "No retirement age makes this last — lower expenses, or raise your stack / DCA.";
        btn.hidden = true;
        btn.onclick = null;
        return;
    }

    label.textContent = "Earliest you could retire:";
    btn.hidden = false;
    btn.textContent = "Age " + earliestAge;
    btn.onclick = () => {
        const field = document.getElementById("retirement-age");
        if (field) {
            field.value = earliestAge;
            calculateAndRender();
        }
    };
}

/* ----------------------------------------------------------------
   RENDER: chart
---------------------------------------------------------------- */
let myChart = null;

function renderChart(ages, portfolioValues, retirementAge) {
    const ctx = document.getElementById('myChart').getContext('2d');

    const minPortfolioValue = Math.min(...portfolioValues);
    const suggestedMin = Math.max(0, minPortfolioValue * 0.9);

    const retirementIndex = ages.indexOf(retirementAge);
    let retirementPoint = null;
    if (retirementIndex !== -1) {
        retirementPoint = { x: ages[retirementIndex], y: portfolioValues[retirementIndex] };
    }

    if (myChart) myChart.destroy();

    const gradient = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
    gradient.addColorStop(0, 'rgba(247, 147, 26, .75)');
    gradient.addColorStop(1, 'rgba(247, 147, 26, 0.1)');

    myChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ages,
            datasets: [
                {
                    label: 'Portfolio Value',
                    data: portfolioValues,
                    borderWidth: 3,
                    borderColor: 'rgb(247, 147, 26)',
                    fill: true,
                    backgroundColor: gradient,
                    pointStyle: false,
                    tension: 0,
                },
                ...(retirementPoint ? [{
                    label: 'Retirement Age',
                    data: [retirementPoint],
                    type: 'scatter',
                    backgroundColor: 'rgba(247, 147, 26, .21)',
                    borderColor: 'rgba(247, 147, 26, 1)',
                    borderWidth: 2,
                    pointRadius: 5,
                    showLine: false,
                    hoverRadius: 8,
                }] : [])
            ]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    type: 'category',
                    title: {
                        display: true, text: 'Age', color: 'rgb(122, 122, 122)',
                        font: { family: 'Raleway, Arial, sans-serif', size: 16, weight: 'bold', style: 'italic', lineHeight: 1.2 },
                        padding: { top: 10, bottom: 0 }
                    },
                    ticks: {
                        autoSkip: false,
                        callback: function (value, index) {
                            return index % 5 === 0 ? this.getLabelForValue(value) : '';
                        }
                    },
                    grid: { color: 'rgba(200, 200, 200, 0.21)' }
                },
                y: {
                    beginAtZero: false,
                    suggestedMin: suggestedMin,
                    title: {
                        display: true, text: 'BTC Value (USD)', color: 'rgb(122, 122, 122)',
                        font: { family: 'Raleway, Arial, sans-serif', size: 16, weight: 'bold', style: 'italic', lineHeight: 1.2 },
                        padding: { top: 0, bottom: 16 }
                    },
                    ticks: {
                        autoSkip: false,
                        maxTicksLimit: 7,
                        callback: function (value) { return '$' + value.toLocaleString(); }
                    }
                }
            },
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(0,0,0,0.7)',
                    titleColor: '#fff', bodyColor: '#fff', padding: 10,
                    callbacks: {
                        title: function (context) { return 'Age: ' + context[0].label; },
                        label: function (context) {
                            return context.dataset.label === 'Retirement Age'
                                ? `Retirement Portfolio Value: $${Math.round(context.parsed.y).toLocaleString()}`
                                : `Portfolio Value: $${Math.round(context.parsed.y).toLocaleString()}`;
                        }
                    }
                }
            }
        }
    });
}

/* ----------------------------------------------------------------
   MAIN
---------------------------------------------------------------- */
async function calculateAndRender() {
    const currentAge = parseInt(getVal("current-age"), 10);
    const btcStack = parseFloat(stripCommas(getVal("btc-stack")));
    const currentBtcPrice = parseFloat(stripCommas(getVal("btc-price")));
    const retirementAge = parseInt(getVal("retirement-age"), 10);
    const lifeExpectancyAge = parseInt(getVal("life-expectancy-age"), 10);
    const monthlyExpenses = parseFloat(stripCommas(getVal("monthly-expenses")));
    const monthlyContribution = parseFloat(stripCommas(getVal("monthly-purchase")));
    const annualInflation = parseFloat(stripCommas(getVal("annual-inflation"))) / 100;
    const predictionModel = getVal("prediction-model");
    const sellStrategy = getVal("sell-strategy") || "optimized";

    // Reflect the chosen model in the CAGR field BEFORE running the sim,
    // so the Linear model reads the value the user actually sees.
    updateCagrField(predictionModel, currentBtcPrice);

    const values = [currentAge, btcStack, currentBtcPrice, retirementAge,
        lifeExpectancyAge, monthlyExpenses, monthlyContribution, annualInflation];
    const invalid =
        !(currentAge > 0) ||
        !(btcStack >= 0) ||
        !(currentBtcPrice > 0) ||
        !(lifeExpectancyAge > currentAge) ||
        !(retirementAge >= currentAge) ||
        !(retirementAge <= lifeExpectancyAge) ||
        !(monthlyExpenses >= 0) ||
        !(monthlyContribution >= 0) ||
        !(annualInflation >= 0) ||
        values.some(Number.isNaN);

    if (invalid) {
        console.warn("Invalid input detected, skipping calculation.");
        return;
    }

    const simParams = {
        currentAge, btcStack, currentBtcPrice, retirementAge, lifeExpectancyAge,
        baseMonthlyExpense: monthlyExpenses, monthlyContribution, annualInflation,
        predictionModel, sellStrategy,
    };

    // Build the price path once; reuse it for the chosen-age sim and the solver.
    const prices = buildMonthlyPrices(currentAge, lifeExpectancyAge, currentBtcPrice, predictionModel);
    const sim = runSimulation(simParams, prices);
    const earliestAge = findEarliestRetirementAge(simParams, prices);

    const currentYear = new Date().getFullYear();
    const rows = aggregateAnnual(sim, currentYear);

    renderTable(rows, retirementAge, sim, btcStack, currentBtcPrice);
    renderVerdict(sim, lifeExpectancyAge);
    renderEarliest(earliestAge);
    renderChart(rows.map(r => r.age), rows.map(r => r.value), retirementAge);
}

/* ----------------------------------------------------------------
   INIT + EVENT WIRING
---------------------------------------------------------------- */
async function init() {
    const btcPrice = await fetchCurrentBtcPrice();
    if (btcPrice !== null) {
        document.getElementById('btc-price').value = btcPrice.toLocaleString();
    }
    await calculateAndRender();
}

window.addEventListener('DOMContentLoaded', init);

document.querySelectorAll(
    '#current-age, #btc-stack, #btc-price, #retirement-age, #life-expectancy-age, ' +
    '#monthly-expenses, #monthly-purchase, #annual-inflation, ' +
    '#prediction-model, #updated-cagr, #sell-strategy'
).forEach(input => {
    input.addEventListener('input', calculateAndRender);
    input.addEventListener('change', calculateAndRender);
});

// Reformat currency/quantity fields with thousands separators once the user
// leaves them (they ship pre-formatted, but typing overwrites that).
function formatFieldWithCommas(id, maximumFractionDigits) {
    const el = document.getElementById(id);
    el.addEventListener('blur', function () {
        const num = parseFloat(stripCommas(this.value));
        if (!isNaN(num)) {
            this.value = num.toLocaleString(undefined, { maximumFractionDigits });
        }
    });
}

formatFieldWithCommas('btc-stack', 8);
formatFieldWithCommas('btc-price', 0);
formatFieldWithCommas('monthly-expenses', 0);
formatFieldWithCommas('monthly-purchase', 0);
