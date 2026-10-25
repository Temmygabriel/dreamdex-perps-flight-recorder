import "./app.css";
import { calculateStress } from "./stress-model.js";
type Side = "long" | "short";
type MarketRecord = { symbol?: string; name?: string; baseSymbol?: string; quoteSymbol?: string; markPrice?: number|string; mark?: number|string; price?: number|string; minQuantity?: number|string; minSize?: number|string; tickSize?: number|string; lotSize?: number|string; maintenanceMarginRate?: number|string; maintenanceMargin?: number|string; [key:string]: unknown };
type Scenario = { createdAt:string; product:"Perps Stress Lab"; version:"0.1.0"; network:{name:string;chainId:number}; source:"manual-input"|"live-order-book-midpoint"; priceReference:{source:string;timestamp:string|null;bestBid:number|null;bestAsk:number|null}; side:Side; market:string; entryPrice:number; quantity:number; leverage:number; startingMarginPercent:number; startingMarginUsd:number; shockPercent:number; stressedPrice:number; pnlUsd:number; funding:{enabled:boolean;rate8hPercent:number;hourlySettlements:number;estimatedUsd:number;assumption:string}; equityUsd:number; maintenancePercent:number; maintenanceUsd:number; headroomUsd:number; thresholdStatus:"above-estimate"|"at-or-below-estimate"; assumptions:string[] };
const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const fmt = (n:number, digits=2) => Number.isFinite(n) ? new Intl.NumberFormat("en-US",{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(n) : "—";
const usd = (n:number) => (n < 0 ? "−$" : "$") + fmt(Math.abs(n));
const pct = (n:number) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n),1) + "%";
let side:Side = "long";
let markets:MarketRecord[] = [];
let latest:Scenario | null = null;
let lastRunAt:string | null = null;
let entryPriceSource: "manual-input" | "live-order-book-midpoint" = "manual-input";
let entryWasManuallyEdited = false;
let marketPriceRequestId = 0;
let marketRiskRequestId = 0;
let accountRiskRequestId = 0;
let priceReference: {source:string;timestamp:string|null;bestBid:number|null;bestAsk:number|null} = {source:"manual input",timestamp:null,bestBid:null,bestAsk:null};

function num(id:string):number { return Number($<HTMLInputElement | HTMLSelectElement>(id).value); }
function val(id:string):string { return $<HTMLInputElement | HTMLSelectElement>(id).value; }
function setText(id:string,value:string){ $<HTMLElement>(id).textContent=value; }
function readInputs(){
  const entry=num("entry"), quantity=num("quantity"), marginPercent=num("starting-margin"), shock=num("shock"), maintenance=num("maintenance");
  const fundingEnabled=$<HTMLInputElement>("funding-toggle").checked, fundingRate=num("funding-rate"), periods=num("funding-periods");
  if (![entry,quantity,marginPercent,shock,maintenance].every(Number.isFinite) || entry<=0 || quantity<=0 || marginPercent<=0 || maintenance<=0 || maintenance>50) throw new Error("Enter positive prices and quantities, a positive margin, and a maintenance rate between 0 and 50%.");
  if (fundingEnabled && (!Number.isFinite(fundingRate) || !Number.isFinite(periods))) throw new Error("Check the funding inputs.");
  return {entry,quantity,marginPercent,shock,maintenance,fundingEnabled,fundingRate,periods};
}
function compute(){
  const x=readInputs();
  const market=val("market");
  const calculated=calculateStress({
    side, entryPrice:x.entry, quantity:x.quantity, startingMarginPercent:x.marginPercent,
    shockPercent:x.shock, maintenancePercent:x.maintenance,
    fundingEnabled:x.fundingEnabled, fundingRate8hPercent:x.fundingRate, fundingPeriods:x.periods
  });
  const assumptions=[
    "One hypothetical position only; dreamDEX uses cross margin by default, and this model omits account-wide collateral and offsets from other positions.",
    "Estimated equity = starting margin + directional unrealised P&L + optional simplified funding estimate.",
    "Maintenance requirement = quantity × stressed price × user-entered maintenance percentage.",
    "Maker/taker fees are documented as 0% on current testnet; liquidation fees, gas/stop-order costs, spread/slippage, realised/unrealised accounting differences, liquidation execution, insurance, backstop and ADL are excluded.",
    "Funding rate is quoted per 8-hour window and applied one eighth per hourly settlement, using entry notional and a constant assumed rate; it is not a forecast.",
    "This result is not an official dreamDEX liquidation price or liquidation status.",
    "A live reference price, when present, is a top-of-book bid/ask midpoint, not the protocol mark price."
  ];
  return {createdAt:new Date().toISOString(),product:"Perps Stress Lab",version:"0.1.0",network:{name:"Somnia Hideki Testnet",chainId:50383},source:entryPriceSource,priceReference:{...priceReference},side,market,entryPrice:x.entry,quantity:x.quantity,leverage:calculated.leverage,startingMarginPercent:x.marginPercent,startingMarginUsd:calculated.startingMarginUsd,shockPercent:x.shock,stressedPrice:calculated.stressedPrice,pnlUsd:calculated.pnlUsd,funding:{enabled:x.fundingEnabled,rate8hPercent:x.fundingRate,hourlySettlements:x.periods,estimatedUsd:calculated.fundingUsd,assumption:x.fundingEnabled?"Constant 8h quoted rate, settled one eighth per hour on entry notional; calculated for the selected hourly settlements.":"Funding excluded."},equityUsd:calculated.equityUsd,maintenancePercent:x.maintenance,maintenanceUsd:calculated.maintenanceUsd,headroomUsd:calculated.headroomUsd,thresholdStatus:calculated.thresholdStatus,assumptions} satisfies Scenario;
}
function update(){
 try{
  const wasInvalid = document.documentElement.dataset.scenarioState === "invalid";
  const s=compute(); latest=s;
  delete document.documentElement.dataset.scenarioState;
  $<HTMLButtonElement>("export-json").disabled=false;
  $<HTMLButtonElement>("copy-summary").disabled=false;
  if (wasInvalid) setText("export-feedback", "");
  const shock=num("shock");
  setText("margin-label",fmt(s.startingMarginPercent,0)+"% of notional");
  setText("shock-label",pct(shock)); $("shock-label").style.color=shock<0?"var(--red)":shock>0?"var(--green)":"var(--text)";
  setText("shock-icon",shock<0?"↘":shock>0?"↗":"→");
  $("shock-icon").style.color=shock<0?"var(--red)":shock>0?"var(--green)":"var(--text)";
  setText("result-price",usd(s.stressedPrice));setText("price-change",pct(s.shockPercent)+" from entry");
  setText("result-pnl",usd(s.pnlUsd));$("result-pnl").className=s.pnlUsd<0?"negative":s.pnlUsd>0?"positive":"";
  setText("pnl-percent",pct(s.pnlUsd/s.startingMarginUsd*100)+" of starting margin");
  setText("result-equity",usd(s.equityUsd));$("result-equity").className=s.equityUsd<0?"negative":"";
  setText("result-headroom",usd(s.headroomUsd));$("result-headroom").className=s.headroomUsd<0?"negative":"positive";
  setText("headroom-sub",s.thresholdStatus==="above-estimate"?"Above simplified maintenance estimate":"At or below simplified maintenance estimate");
  setText("trace-price",fmt(s.entryPrice)+" × (1 "+(s.shockPercent<0?"− "+fmt(Math.abs(s.shockPercent/100),3):"+ "+fmt(s.shockPercent/100,3))+")");
  setText("trace-price-value",usd(s.stressedPrice));
  setText("trace-pnl",s.side==="long"?fmt(s.quantity)+" × ("+fmt(s.stressedPrice)+" − "+fmt(s.entryPrice)+")":fmt(s.quantity)+" × ("+fmt(s.entryPrice)+" − "+fmt(s.stressedPrice)+")");
  setText("trace-pnl-value",usd(s.pnlUsd));
  setText("trace-equity",fmt(s.startingMarginUsd)+" + ("+fmt(s.pnlUsd)+(s.funding.enabled?" + funding "+fmt(s.funding.estimatedUsd):"")+")");
  setText("trace-equity-value",usd(s.equityUsd));
  setText("trace-maint",fmt(s.quantity)+" × "+fmt(s.stressedPrice)+" × "+fmt(s.maintenancePercent,2)+"%");
  setText("trace-maint-value",usd(s.maintenanceUsd));
  setText("bar-equity-label",usd(s.equityUsd));setText("bar-maint-label",usd(s.maintenanceUsd));
  const max=Math.max(Math.abs(s.equityUsd),Math.abs(s.maintenanceUsd),1);
  $("equity-bar").style.width=Math.max(0,Math.min(100,Math.max(0,s.equityUsd)/max*100))+"%";
  $("maintenance-bar").style.width=Math.max(0,Math.min(100,s.maintenanceUsd/max*100))+"%";
  const threshold=$("threshold-note");threshold.classList.toggle("warning",s.thresholdStatus!=="above-estimate");
  threshold.querySelector("strong")!.textContent=s.thresholdStatus==="above-estimate"?"Above estimated maintenance":"At or below estimated maintenance";
  threshold.querySelector("p")!.textContent=s.thresholdStatus==="above-estimate"?"Positive headroom in this simplified model. This is not an official liquidation status.":"This model's headroom is non-positive. It does not prove that dreamDEX would liquidate this position.";
  setText("scenario-status",lastRunAt?"SCENARIO REVIEWED":"LIVE PREVIEW");
  setText("report-meta","Local estimate · "+new Date(s.createdAt).toLocaleTimeString());
  setText("funding-note",s.funding.enabled?"Assumes "+fmt(s.funding.rate8hPercent,3)+"% per 8h window, settled hourly, over "+s.funding.hourlySettlements+" hourly settlements on entry notional.":"Funding is off. Turn it on to model an explicit constant-rate assumption.");
  document.querySelectorAll<HTMLButtonElement>("[data-shock]").forEach(b=>{const selected=Number(b.dataset.shock)===shock;b.classList.toggle("selected",selected);b.setAttribute("aria-pressed",String(selected));});
 }catch(e){
  latest=null;
  lastRunAt=null;
  document.documentElement.dataset.scenarioState="invalid";
  $<HTMLButtonElement>("export-json").disabled=true;
  $<HTMLButtonElement>("copy-summary").disabled=true;
  for (const id of ["result-price","price-change","result-pnl","pnl-percent","result-equity","result-headroom","headroom-sub","trace-price","trace-price-value","trace-pnl","trace-pnl-value","trace-equity","trace-equity-value","trace-maint","trace-maint-value","bar-equity-label","bar-maint-label"]) setText(id,"—");
  $("result-pnl").className="";
  $("result-equity").className="";
  $("result-headroom").className="";
  $("equity-bar").style.width="0%";
  $("maintenance-bar").style.width="0%";
  const threshold=$("threshold-note");
  threshold.classList.add("warning");
  threshold.querySelector("strong")!.textContent="Results unavailable";
  threshold.querySelector("p")!.textContent="Correct the scenario inputs before reviewing or exporting results.";
  setText("scenario-status","CHECK INPUTS");
  setText("export-feedback",e instanceof Error?e.message:"Please check your inputs.");
}
}
function markRun(){lastRunAt=null;update();if(!latest)return;lastRunAt=new Date().toISOString();setText("scenario-status","SCENARIO REVIEWED");$("results").scrollIntoView({behavior:"smooth",block:"start"});}
function download(){
 try{const s=compute();latest=s;const report={...s,generatedAt:new Date().toISOString(),verification:{onChain:false,liveAccountDataUsed:false,transactionHash:null},disclaimer:"This is a local scenario estimate, not on-chain evidence, financial advice, an official liquidation price, or a prediction of protocol liquidation behavior."};const blob=new Blob([JSON.stringify(report,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="perps-stress-lab-"+new Date().toISOString().replace(/[:.]/g,"-")+".json";a.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);setText("export-feedback","Scenario JSON exported. It is labelled as local, non-on-chain evidence.");}catch(e){setText("export-feedback",e instanceof Error?e.message:"Unable to export this scenario.");}
}
async function copySummary(){
 try{const s=compute();const summary=["PERPS STRESS LAB — SCENARIO SUMMARY","Network: Somnia Hideki testnet (50383)","Source: "+s.source+"; not on-chain evidence","Market: "+s.market,"Direction: "+s.side.toUpperCase(),"Entry: "+usd(s.entryPrice),"Quantity: "+fmt(s.quantity,8),"Shock: "+pct(s.shockPercent),"Stressed price: "+usd(s.stressedPrice),"Estimated P&L: "+usd(s.pnlUsd),"Estimated equity: "+usd(s.equityUsd),"Maintenance estimate: "+usd(s.maintenanceUsd),"Headroom: "+usd(s.headroomUsd),"Funding estimate: "+usd(s.funding.estimatedUsd),"","This simplified single-position estimate excludes cross-margin offsets, account-wide collateral, liquidation fees and gas costs, full protocol accounting and liquidation execution."].join("\n");await navigator.clipboard.writeText(summary);setText("export-feedback","Readable scenario summary copied.");}catch{setText("export-feedback","Clipboard access failed. Use Export scenario JSON instead.");}
}
async function loadMarketPrice(symbol:string){
 const requestId=++marketPriceRequestId;
 try{
  const response=await fetch("/api/market-price?symbol="+encodeURIComponent(symbol),{headers:{accept:"application/json"},cache:"no-store",signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error("Order-book endpoint returned HTTP "+response.status);
  const payload=await response.json() as {ok?:boolean;referencePrice?:number;bestBid?:number;bestAsk?:number;priceSource?:string;timestamp?:string};
  const midpoint=Number(payload.referencePrice);
  const bestBid=Number(payload.bestBid),bestAsk=Number(payload.bestAsk);
  const quoteTimestamp=Date.parse(payload.timestamp??"");
  const expectedMidpoint=(bestBid+bestAsk)/2;
  if(!payload.ok||!Number.isFinite(midpoint)||midpoint<=0||!Number.isFinite(bestBid)||bestBid<=0||!Number.isFinite(bestAsk)||bestAsk<bestBid||!Number.isFinite(expectedMidpoint)||Math.abs(midpoint-expectedMidpoint)>Math.max(1e-8,Math.abs(midpoint)*1e-8)||!Number.isFinite(quoteTimestamp)||Math.abs(Date.now()-quoteTimestamp)>5*60*1000)throw new Error("The order-book response was invalid, inconsistent, or stale.");
  if(requestId!==marketPriceRequestId||val("market")!==symbol)return;
  // Keep the latest book quote as provenance, even when the user chose a manual entry.
  priceReference={source:payload.priceSource??"Top-of-book midpoint; not the protocol mark price.",timestamp:payload.timestamp??null,bestBid,bestAsk};
  if(entryWasManuallyEdited){
   entryPriceSource="manual-input";
   setText("market-hint","Manual entry retained · live book midpoint "+usd(midpoint)+" available, not a mark price.");
   setText("method-data","A read-only Hideki book quote was fetched for "+symbol+". Your manually entered entry price was preserved; the quote is reference context only and calculations do not use live account margin.");
  }else{
   $<HTMLInputElement>("entry").value=String(midpoint);
   entryPriceSource="live-order-book-midpoint";
   setText("market-hint","Live book midpoint "+usd(midpoint)+" · not a mark price. Entry remains editable.");
   setText("method-data","Read-only Hideki order book returned a two-sided quote for "+symbol+". The entry field is prefilled with its bid/ask midpoint; calculations do not use live account margin.");
  }
  update();
 }catch(e){
  if(requestId!==marketPriceRequestId||val("market")!==symbol)return;
  if(!entryWasManuallyEdited){
   entryPriceSource="manual-input";
   priceReference={source:"manual input; live book midpoint unavailable",timestamp:null,bestBid:null,bestAsk:null};
   setText("market-hint","Live reference price unavailable; enter an entry price manually.");
  }else{
   entryPriceSource="manual-input";
   setText("market-hint","Live reference price unavailable; your manual entry is retained.");
  }
  setText("method-data","Could not load a live order-book midpoint: "+(e instanceof Error?e.message:"unknown error")+". The manual scenario remains available.");
  update();
 }
}
async function loadMarkets(){
 const status=$("data-status");status.innerHTML='<span class="status-dot muted"></span> Checking market data…';
 try{
  const response=await fetch("/api/markets",{headers:{accept:"application/json"},cache:"no-store",signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error("Market endpoint returned HTTP "+response.status);
  const payload:unknown=await response.json();
  const root=payload as {markets?:unknown;data?:unknown;result?:unknown};
  const raw=Array.isArray(payload)?payload:[root.markets,root.data,root.result].find(Array.isArray);
  if(!Array.isArray(raw)||raw.length===0)throw new Error("No market rows returned by the API.");
  markets=raw.filter((m):m is MarketRecord=>!!m&&typeof m==="object") as MarketRecord[];
  const select=$<HTMLSelectElement>("market");const previous=select.value;
  select.replaceChildren();
  for(const m of markets){const symbol=String(m.symbol??m.name??m.baseSymbol??"");if(!symbol)continue;const opt=document.createElement("option");opt.value=symbol;opt.textContent=symbol;select.append(opt);}
  if(!select.options.length)throw new Error("The response did not contain readable market symbols.");
  if([...select.options].some(o=>o.value===previous))select.value=previous;
  status.innerHTML='<span class="status-dot"></span> Market list loaded';
  setText("method-data","Loaded "+markets.length+" live Hideki market definitions. Fetching a read-only order-book midpoint for the selected market; no account margin or liquidation state is queried.");
  void loadMarketPrice(select.value);
  void loadMarketRisk(select.value);
 }catch(e){
  status.innerHTML='<span class="status-dot muted"></span> Live data unavailable';
  setText("market-hint","Live market metadata unavailable; this remains a manual hypothetical scenario.");
  setText("method-data","Read-only market-data request failed: "+(e instanceof Error?e.message:"unknown error")+". Manual scenarios remain available; no live-data claim is made.");
 }
 update();
}


async function loadMarketRisk(symbol:string){
 const requestId=++marketRiskRequestId;
 const card=$<HTMLElement>("live-risk-card");
 card.dataset.state="loading";
 setText("market-risk-status","Loading protocol risk parameters…");
 setText("market-risk-note","Reading static market risk settings and the protocol mark-health snapshot from Hideki.");
 try{
  const response=await fetch("/api/market-risk?symbol="+encodeURIComponent(symbol),{headers:{accept:"application/json"},cache:"no-store",signal:AbortSignal.timeout(15000)});
  const payload=await response.json() as {ok?:boolean;error?:string;symbol?:string;baseSymbol?:string;readAt?:string;riskParameters?:Record<string,unknown>;marketHealth?:Record<string,unknown>};
  if(requestId!==marketRiskRequestId||val("market")!==symbol)return;
  if(!response.ok||!payload.ok)throw new Error(payload.error??"Market risk endpoint did not return verified data.");
  const risk=payload.riskParameters??{};
  const health=payload.marketHealth??{};
  const percent=(value:unknown)=>value==null?"Unavailable":fmt(Number(value),2)+"%";
  setText("market-risk-imf",percent(risk.initialMarginFloorPercent));
  setText("market-risk-effective-imf",percent(risk.effectiveInitialMarginPercent));
  setText("market-risk-maintenance",percent(risk.maintenanceMarginPercent));
  setText("market-risk-closeout",percent(risk.closeOutMarginPercent));
  setText("market-risk-fees",risk.makerFeePercent==null||risk.takerFeePercent==null?"Unavailable":fmt(Number(risk.makerFeePercent),3)+"% / "+fmt(Number(risk.takerFeePercent),3)+"%");
  setText("market-risk-max-position",risk.maxPositionSizeBase==null?"Unavailable":fmt(Number(risk.maxPositionSizeBase),8)+" "+String(payload.baseSymbol??""));
  setText("market-risk-mark",health.priceable===true&&health.markPrice!=null?usd(Number(health.markPrice)):"Unavailable");
  if(health.priceable===true){
   card.dataset.state="ready";
   const readAt=payload.readAt?new Date(payload.readAt):null;
   const validReadAt=readAt!==null&&Number.isFinite(readAt.getTime());
   const ageMinutes=validReadAt?Math.max(0,Math.floor((Date.now()-readAt!.getTime())/60000)):null;
   const freshness=ageMinutes===null?"read time unavailable":ageMinutes===0?"read just now":ageMinutes===1?"read 1 min ago":"read "+ageMinutes+" min ago";
   setText("market-risk-status","Protocol mark available · "+freshness+(validReadAt?" · "+readAt!.toLocaleTimeString():""));
   card.dataset.freshness=ageMinutes!==null&&ageMinutes>5?"aging":"fresh";
   setText("market-risk-note","Static risk limits come from the pool configuration. Effective initial margin reflects the current protocol snapshot; this does not replace the manual maintenance assumption below or the editable order-book midpoint used as scenario entry.");
  }else{
   card.dataset.state="stale";
   card.dataset.freshness="unknown";
   setText("market-risk-status","Mark stale or unpriceable");
   setText("market-risk-note","Static risk limits are still available, but Hideki did not mark this market priceable. Do not treat missing price data as zero or infer liquidation safety.");
  }
 }catch(error){
  if(requestId!==marketRiskRequestId||val("market")!==symbol)return;
  card.dataset.state="error";
  card.dataset.freshness="unknown";
  setText("market-risk-status","Live risk data unavailable");
  for(const id of ["market-risk-imf","market-risk-effective-imf","market-risk-maintenance","market-risk-closeout","market-risk-fees","market-risk-max-position","market-risk-mark"])setText(id,"—");
  setText("market-risk-note","Could not verify the live protocol risk snapshot. Check the connection and retry; no missing values are treated as zero, and the hypothetical scenario remains separate.");
 }
}

function accountAmount(value:unknown):string{
 if(value===null||value===undefined||value==="")return "Unavailable";
 const n=Number(value);
 return Number.isFinite(n)?usd(n):"Unavailable";
}
function accountQuantity(value:unknown):string{
 if(value===null||value===undefined||value==="")return "Unavailable";
 const n=Number(value);
 return Number.isFinite(n)?fmt(n,8):"Unavailable";
}
function accountField(label:string,value:string){
 const box=document.createElement("div");box.className="position-metric";
 const name=document.createElement("span");name.textContent=label;
 const result=document.createElement("strong");result.textContent=value;
 box.append(name,result);return box;
}
function renderAccountPositions(rows:unknown, status:string){
 const root=$<HTMLElement>("account-position-list");
 root.replaceChildren();
 if(!Array.isArray(rows)||rows.length===0){
  const empty=document.createElement("p");empty.className="account-risk-empty";
  empty.textContent=status==="unavailable"
    ?"Position details could not be loaded. Account health was not inferred from missing position data."
    :"No open positions were returned for this MarginBank snapshot.";
  root.append(empty);return;
 }
 for(const item of rows){
  const p=item as Record<string,unknown>;
  const card=document.createElement("article");card.className="account-position-card";
  const head=document.createElement("div");head.className="account-position-head";
  const title=document.createElement("div");title.className="account-position-title";
  const strong=document.createElement("strong");strong.textContent=String(p.symbol??"Unknown market")+" · "+String(p.side??"unknown").toUpperCase();
  const pool=document.createElement("small");const poolAddress=String(p.poolAddress??"");
  pool.textContent=poolAddress?poolAddress.slice(0,8)+"…"+poolAddress.slice(-6):"Pool address unavailable";
  title.append(strong,pool);
  const chip=document.createElement("span");chip.className="position-health-chip";chip.dataset.state=p.priceable===true?"ready":"stale";
  chip.textContent=p.priceable===true?"MARK AVAILABLE":"MARK UNAVAILABLE";
  head.append(title,chip);card.append(head);
  const metrics=document.createElement("div");metrics.className="position-metrics";
  metrics.append(
   accountField("Quantity",accountQuantity(p.quantityBase)),
   accountField("Entry price",p.entryPrice==null?"Unavailable":accountAmount(p.entryPrice)),
   accountField("Mark price",p.markPrice==null?"Unavailable":accountAmount(p.markPrice)),
   accountField("Notional",accountAmount(p.notionalUsdso)),
   accountField("Unrealised P&L",accountAmount(p.unrealizedPnlUsdso)),
   accountField("Funding owed",accountAmount(p.accruedFundingOwedUsdso)),
   accountField("Maintenance share",accountAmount(p.maintenanceMarginRequirementUsdso)),
   accountField("SDK liquidation estimate",p.estimatedLiquidationPrice==null?"Unavailable":accountAmount(p.estimatedLiquidationPrice))
  );
  card.append(metrics);
  if(p.liquidationPriceStatus!=="sdk-estimate"){
   const note=document.createElement("p");note.className="account-risk-caveat";
   note.textContent="Liquidation estimate unavailable: "+String(p.liquidationPriceStatus??"price status unknown")+". No zero-price substitute was used.";
   card.append(note);
  }
  root.append(card);
 }
}
async function runAccountRisk(){
 const requestId=++accountRiskRequestId;
 const address=$<HTMLInputElement>("account-risk-address").value.trim();
 const button=$<HTMLButtonElement>("account-risk-submit");
 const resultRoot=$<HTMLElement>("account-risk-results");
 if(!/^0x[0-9a-fA-F]{40}$/.test(address)){
  setText("account-risk-status","Enter a valid public EVM address (0x followed by 40 hexadecimal characters). Never enter a private key.");
  $("account-risk-status").dataset.state="warning";resultRoot.hidden=true;return;
 }
 button.disabled=true;setText("account-risk-submit","Checking account…");
 setText("account-risk-status","Reading the MarginBank and active positions from Hideki. No signature or transaction will be requested.");
 $("account-risk-status").dataset.state="";
 resultRoot.hidden=true;
 try{
  const symbol=val("market");
  const url="/api/account-risk?address="+encodeURIComponent(address)+"&symbol="+encodeURIComponent(symbol);
  const response=await fetch(url,{headers:{accept:"application/json"},cache:"no-store",signal:AbortSignal.timeout(25000)});
  const payload=await response.json() as {ok?:boolean;error?:string;readAt?:string;accountHealthAvailable?:boolean;accountHealthStatus?:string;positionsStatus?:string;positionsSource?:string;summary?:Record<string,unknown>;positions?:unknown;positionCount?:number|null;network?:{chainId?:number};marketScope?:{symbol?:string}};
  if(requestId!==accountRiskRequestId)return;
  if(!response.ok||!payload.ok)throw new Error(payload.error??"The account-risk endpoint did not return a usable snapshot.");
  const summary=payload.summary??{};
  const available=payload.accountHealthAvailable===true;
  const amount=(key:string)=>accountAmount(summary[key]);
  setText("account-risk-equity",amount("equityUsdso"));
  setText("account-risk-unlocked",amount("unlockedCollateralUsdso"));
  setText("account-risk-locked",amount("lockedCollateralUsdso"));
  setText("account-risk-withdrawable",amount("withdrawableUsdso"));
  setText("account-risk-im",amount("initialMarginRequirementUsdso"));
  setText("account-risk-mm",amount("maintenanceMarginRequirementUsdso"));
  setText("account-risk-cm",amount("closeOutMarginRequirementUsdso"));
  setText("account-risk-position-count",payload.positionsStatus==="unavailable"?"Unavailable":String(payload.positionCount??0));
  setText("account-risk-health-badge",String(summary.marginStatus??payload.accountHealthStatus??"unknown"));
  setText("account-risk-position-source",payload.positionsSource?.toLowerCase().includes("indexer")?"INDEXER FALLBACK":"ON-CHAIN");
  renderAccountPositions(payload.positions,payload.positionsStatus??"available");
  resultRoot.hidden=false;
  if(available){
   $("account-risk-status").dataset.state="ready";
   setText("account-risk-status","Account snapshot loaded for "+address.slice(0,8)+"…"+address.slice(-6)+" · "+String(payload.marketScope?.symbol??symbol)+" · read-only · "+(payload.readAt?new Date(payload.readAt).toLocaleTimeString():"time unavailable")+". This is a protocol snapshot, not a liquidation execution guarantee.");
  }else{
   $("account-risk-status").dataset.state="warning";
   setText("account-risk-status","Account health is unavailable because a mark or RPC read may be stale. "+(summary.collateralBasisUsdso!=null?"Collateral basis (not equity): "+accountAmount(summary.collateralBasisUsdso)+". ":"")+"No healthy/unhealthy verdict or liquidation price was inferred; position rows may use an explicitly labelled indexer fallback.");
  }
 }catch(error){
  if(requestId!==accountRiskRequestId)return;
  resultRoot.hidden=true;
  $("account-risk-status").dataset.state="error";
  setText("account-risk-status",error instanceof Error?error.message:"Account-risk read failed. No verdict was produced.");
 }finally{
  if(requestId===accountRiskRequestId){button.disabled=false;setText("account-risk-submit","Check account risk ↗");}
 }
}

type ThemeMode = "light" | "dim";
const THEME_STORAGE_KEY = "perps-stress-lab-theme";

function applyTheme(mode: ThemeMode, persist = false): void {
  document.documentElement.dataset.theme = mode;
  const dim = mode === "dim";
  const button = $<HTMLButtonElement>("theme-toggle");
  button.setAttribute("aria-pressed", String(dim));
  button.setAttribute("aria-label", dim ? "Switch to light mode" : "Switch to dim mode");
  button.title = dim ? "Switch to light mode" : "Switch to dim mode";
  setText("theme-toggle-label", dim ? "Light mode" : "Dim mode");
  setText("theme-toggle-icon", dim ? "☼" : "◐");
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = dim ? "#14191f" : "#eef2f7";
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, mode); } catch { /* Theme still applies for this page. */ }
  }
}

let initialTheme: ThemeMode = "light";
try {
  if (localStorage.getItem(THEME_STORAGE_KEY) === "dim") initialTheme = "dim";
} catch { /* Storage can be unavailable in private browsing. */ }
applyTheme(initialTheme);
$("theme-toggle").addEventListener("click", () => {
  const next: ThemeMode = document.documentElement.dataset.theme === "dim" ? "light" : "dim";
  applyTheme(next, true);
});

document.querySelectorAll<HTMLButtonElement>("[data-side]").forEach(b=>b.addEventListener("click",()=>{lastRunAt=null;side=b.dataset.side as Side;document.querySelectorAll<HTMLButtonElement>("[data-side]").forEach(x=>{const selected=x===b;x.classList.toggle("active",selected);x.setAttribute("aria-pressed",String(selected));});update();}));
document.querySelectorAll<HTMLButtonElement>("[data-shock]").forEach(b=>b.addEventListener("click",()=>{lastRunAt=null; $<HTMLInputElement>("shock").value=b.dataset.shock!;update();}));
["entry","quantity","maintenance","starting-margin","shock","funding-rate","funding-periods","market"].forEach(id=>$<HTMLInputElement | HTMLSelectElement>(id).addEventListener("input",()=>{
 lastRunAt=null;
 if(id==="starting-margin"){
  const percent=num("starting-margin");const leverage=$<HTMLSelectElement>("leverage");const choices=[2,5,10,20];
  const exactChoice=choices.find((candidate)=>Math.abs(100/candidate-percent)<0.001);
  let custom=leverage.querySelector<HTMLOptionElement>('option[value="custom"]');
  if(!custom){custom=document.createElement("option");custom.value="custom";custom.disabled=true;leverage.append(custom);}
  if(exactChoice!==undefined)leverage.value=String(exactChoice);
  else{custom.textContent="Custom · "+fmt(100/percent,1)+"×";leverage.value="custom";}
 }
 if(id==="entry"){
  entryWasManuallyEdited=true;
  entryPriceSource="manual-input";
  if(!priceReference.timestamp)priceReference={source:"manual input; live book midpoint unavailable",timestamp:null,bestBid:null,bestAsk:null};
 }
 if(id==="market"){
  // A quote for the newly selected market must not reuse an old asset's entry price.
  entryWasManuallyEdited=false;
  $<HTMLInputElement>("entry").value="";
  entryPriceSource="manual-input";
  priceReference={source:"waiting for selected market quote",timestamp:null,bestBid:null,bestAsk:null};
 }
 update();
 if(id==="market"){void loadMarketPrice(val("market"));void loadMarketRisk(val("market"));}
}));
$("funding-toggle").addEventListener("change",()=>{lastRunAt=null;const enabled=$<HTMLInputElement>("funding-toggle").checked; $("funding-fields").setAttribute("aria-disabled",String(!enabled));$<HTMLInputElement>("funding-rate").disabled=!enabled;$<HTMLSelectElement>("funding-periods").disabled=!enabled;update();});
$<HTMLSelectElement>("leverage").addEventListener("change",()=>{if(val("leverage")==="custom")return;lastRunAt=null;$<HTMLInputElement>("starting-margin").value=String(100/num("leverage"));update();});
$("run-scenario").addEventListener("click",markRun);
$("export-json").addEventListener("click",download);
$("copy-summary").addEventListener("click",()=>void copySummary());
$("refresh-data").addEventListener("click",()=>void loadMarkets());
$("account-risk-form").addEventListener("submit",(event)=>{event.preventDefault();void runAccountRisk();});
loadMarkets();
update();
