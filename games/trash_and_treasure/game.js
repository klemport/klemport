(() => {
  "use strict";

  const errorBox = document.getElementById("errorBox");
  function showError(err){
    console.error(err);
    if(!errorBox) return;
    errorBox.style.display = "block";
    errorBox.textContent =
      "JavaScript error (game did not start):\n\n" +
      (err?.stack || String(err));
  }

  try {
    // ------------------------------------------------------------
    // Sound effects
    // ------------------------------------------------------------
    const SFX = {
      play: new Audio("play_card.wav"),
      trash: new Audio("trash_alert.wav"),
      replace: new Audio("community_replace.wav"),
      leader: new Audio("new_leader.wav"),
      turn: new Audio("turn_over.wav"),
      gameOver: new Audio("game_over.wav"),
    };
    Object.values(SFX).forEach(a => { a.preload = "auto"; });

    let audioArmed = false;
    function armAudioOnce(){
      audioArmed = true;
      window.removeEventListener("pointerdown", armAudioOnce);
      window.removeEventListener("keydown", armAudioOnce);
    }
    window.addEventListener("pointerdown", armAudioOnce, { once:true });
    window.addEventListener("keydown", armAudioOnce, { once:true });

    function playSfx(name){
      if(!audioArmed) return;
      const src = SFX[name];
      if(!src) return;
      const a = src.cloneNode();
      a.volume = 0.85;
      a.play().catch(()=>{});
    }

    // ------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------
    const SUITS = ["♠","♥","♦","♣"];
    const RANKS = [2,3,4,5,6,7,8,9,10,11,12,13,14];

    const RANK_LABEL = r => r<=10 ? String(r) : ({11:"J",12:"Q",13:"K",14:"A"}[r]);
    const RANK_NAME  = r => r<=10 ? String(r) : ({11:"Jack",12:"Queen",13:"King",14:"Ace"}[r]);

    const ODD_WILDS  = [3,5,7];
    const EVEN_WILDS = [2,4,6];

    const MAX_REVEALED = 4;
    const MAX_TRASH = 3;
    const COMMUNITY_COUNT = 3;

    const AI_STEP_MS = 3000;

    // Delay between play sound and the card appearing
    const CARD_REVEAL_DELAY_MS = 550;

    function isReplacementTrigger(card){
      return !!card && !card.joker && card.s==="♦" && (card.r===11 || card.r===12 || card.r===13);
    }

    function shuffle(a){
      for(let i=a.length-1;i>0;i--){
        const j=Math.floor(Math.random()*(i+1));
        [a[i],a[j]]=[a[j],a[i]];
      }
    }
    function buildDeck(){
      const d=[];
      for(const s of SUITS) for(const r of RANKS) d.push({r,s});
      d.push({joker:true});
      d.push({joker:true});
      shuffle(d);
      return d;
    }

    function cardHTML(c){
      if(c.joker) return "Jkr";
      const rank = RANK_LABEL(c.r);
      const suit = c.s;
      const red = (suit==="♦" || suit==="♥");
      return `${rank}<span class="${red ? "suitRed" : ""}">${suit}</span>`;
    }

    function cardText(c){
      if(c.joker) return "Jkr";
      return `${RANK_LABEL(c.r)}${c.s}`;
    }

    // ------------------------------------------------------------
    // DOM
    // ------------------------------------------------------------
    const resetBtn = document.getElementById("resetBtn");
    const drawBtn = document.getElementById("drawBtn");
    const nextBtn = document.getElementById("nextBtn");
    const playerCountSel = document.getElementById("playerCount");

    const communityCardsEl = document.getElementById("communityCards");
    const availableTrashCardsEl = document.getElementById("availableTrashCards");
    const availableTrashLabelEl = document.getElementById("availableTrashLabel");
    const choiceLabelEl = document.getElementById("choiceLabel");

    const commandPanel = document.getElementById("commandPanel");
    const commandText = document.getElementById("commandText");
    const commandChoices = document.getElementById("commandChoices");

    const pEls = [
      document.getElementById("p1"),
      document.getElementById("p2"),
      document.getElementById("p3"),
      document.getElementById("p4"),
    ];

    if(!resetBtn || !drawBtn || !nextBtn || !playerCountSel ||
       !communityCardsEl || !availableTrashCardsEl || !availableTrashLabelEl || !choiceLabelEl ||
       !commandPanel || !commandText || !commandChoices ||
       pEls.some(x=>!x)){
      throw new Error("Missing required DOM elements. Make sure index.html matches the expected IDs.");
    }

    // ------------------------------------------------------------
    // State
    // ------------------------------------------------------------
    let deck, community, players;
    let current, leaderIndices, phase, openingLock, replaceCtx;
    let numPlayers = 2;

    let hoveredPlayer = null;

    let aiTimer = null;

    // Next-button flow
    let pendingAdvance = null;
    let lastSingleLeader = null;
    let gameOverPlayed = false;

    // reveal-delay lock
    let revealDelayActive = false;
    let revealTimer = null;

    // phases: DRAW, TRASH_PICK, REPLACE_PICK, REPLACE_TARGET, WAIT_NEXT, DONE
    function setModeClass(){
      document.body.classList.toggle("mode2", numPlayers === 2);
    }

    function isAIPlayer(i){
      return (numPlayers === 2 && i === 1);
    }

    function clearTimers(){
      if(aiTimer){ clearTimeout(aiTimer); aiTimer=null; }
      if(revealTimer){ clearTimeout(revealTimer); revealTimer=null; }
      revealDelayActive = false;
    }

function scheduleAI(ms){
  // If an older AI step was already queued, replace it.
  // This prevents stalls when community replacement triggers twice quickly.
  if(aiTimer){
    clearTimeout(aiTimer);
    aiTimer = null;
  }
  aiTimer = setTimeout(() => {
    aiTimer = null;
    maybeAutoPlay();
  }, ms);
}

    function initGame(n){
      clearTimers();

      gameOverPlayed = false;
      lastSingleLeader = null;

      numPlayers = n;
      setModeClass();

      deck = buildDeck();
      community = [];

      players = Array.from({length:numPlayers}, (_,i)=>({
        id: i,
        revealed: [],
        trash: [],
        best: null,
        wildType: (i%2===0) ? "odd" : "even", // P1/P3 odd; P2/P4 even
        trashNextDraw: false,
      }));

      current = 0;
      leaderIndices = [];
      phase = "DRAW";
      openingLock = true;
      replaceCtx = null;

      pendingAdvance = null;

      for(let i=0;i<COMMUNITY_COUNT;i++){
        community.push(deck.pop());
      }

      for(let i=0;i<4;i++){
        pEls[i].style.display = (i < numPlayers) ? "" : "none";
      }

      recompute(true);
      ensureCurrentEligible();
      render();
    }

    resetBtn.addEventListener("click", () => {
      hoveredPlayer = null;
      initGame(numPlayers);
    });

    playerCountSel.addEventListener("change", () => {
      hoveredPlayer = null;
      const val = Number(playerCountSel.value);
      initGame(val === 4 ? 4 : 2);
    });

    pEls.forEach((el, idx) => {
      el.addEventListener("mouseenter", () => {
        if(idx >= numPlayers) return;
        hoveredPlayer = idx;
        render();
      });
      el.addEventListener("mouseleave", () => {
        if(idx >= numPlayers) return;
        hoveredPlayer = null;
        render();
      });
    });

    function viewPlayerIndex(){
      return (hoveredPlayer !== null) ? hoveredPlayer : current;
    }

    // ------------------------------------------------------------
    // Hand eval helpers
    // ------------------------------------------------------------
    function isWild(card, player){
      if(card.joker) return true;
      if(card.s !== "♦") return false;
      return player.wildType==="odd"
        ? ODD_WILDS.includes(card.r)
        : EVEN_WILDS.includes(card.r);
    }

    function lexCompare(a,b){
      const n=Math.max(a.length,b.length);
      for(let i=0;i<n;i++){
        const av=a[i]??0, bv=b[i]??0;
        if(av!==bv) return av-bv;
      }
      return 0;
    }
    function beats(a,b){
      if(!b) return true;
      if(a.cat!==b.cat) return a.cat>b.cat;
      return lexCompare(a.vec,b.vec)>0;
    }
    function equalHands(a,b){
      if(!a || !b) return false;
      if(a.cat!==b.cat) return false;
      return lexCompare(a.vec,b.vec)===0;
    }

    function chooseK(arr,k){
      const res=[];
      function rec(start,combo){
        if(combo.length===k){ res.push(combo.slice()); return; }
        for(let i=start;i<arr.length;i++){
          combo.push(arr[i]);
          rec(i+1,combo);
          combo.pop();
        }
      }
      rec(0,[]);
      return res;
    }

    function bestStraightTop(present, wilds){
      for(let top=14; top>=6; top--){
        let miss=0;
        for(let r=top-4;r<=top;r++) if(!present.has(r)) miss++;
        if(miss<=wilds) return top;
      }
      const wheel=[14,2,3,4,5];
      let miss=0;
      for(const r of wheel) if(!present.has(r)) miss++;
      return (miss<=wilds) ? 5 : 0;
    }

    function bestGroupHandWithWildRanks(natRanks, w){
      let best=null;
      const assign=new Array(w).fill(2);

      function next(){
        for(let i=0;i<w;i++){
          if(assign[i]<14){ assign[i]++; return true; }
          assign[i]=2;
        }
        return false;
      }

      function score(eff){
        const cnt=new Map();
        eff.forEach(r=>cnt.set(r,(cnt.get(r)||0)+1));
        const uniq=[...cnt.keys()].sort((a,b)=>b-a);
        const groups=uniq.map(r=>({r,c:cnt.get(r)}))
          .sort((a,b)=>b.c-a.c||b.r-a.r);
        const flat=eff.slice().sort((a,b)=>b-a);

        if(groups[0].c===5) return {cat:9,name:"Five of a Kind",vec:[groups[0].r]};
        if(groups[0].c===4){
          const quad=groups[0].r;
          const kicker=flat.find(x=>x!==quad) || 0;
          return {cat:7,name:"Four of a Kind",vec:[quad,kicker]};
        }
        if(groups[0].c===3 && groups[1]?.c>=2)
          return {cat:6,name:"Full House",vec:[groups[0].r,groups[1].r]};
        if(groups[0].c===3){
          const trips=groups[0].r;
          const ks=flat.filter(x=>x!==trips).slice(0,2);
          return {cat:3,name:"Three of a Kind",vec:[trips,...ks]};
        }
        if(groups[0].c===2 && groups[1]?.c===2){
          const a=groups[0].r, b=groups[1].r;
          const hi=Math.max(a,b), lo=Math.min(a,b);
          const kicker=flat.find(x=>x!==hi && x!==lo) || 0;
          return {cat:2,name:"Two Pair",vec:[hi,lo,kicker]};
        }
        if(groups[0].c===2){
          const pair=groups[0].r;
          const ks=flat.filter(x=>x!==pair).slice(0,3);
          return {cat:1,name:"One Pair",vec:[pair,...ks]};
        }
        return {cat:0,name:"High Card",vec:flat.slice(0,5)};
      }

      while(true){
        const eff=natRanks.concat(assign);
        const s=score(eff);
        if(!best || beats(s,best)) best=s;
        if(!next()) break;
      }
      return best;
    }

    function evalFive(cards5, player){
      const wilds = cards5.filter(c=>isWild(c,player)).length;
      const natCards = cards5.filter(c=>!isWild(c,player));
      const natRanks = natCards.map(c=>c.r);

      const presentAll = new Set(natRanks);
      const sTop = bestStraightTop(presentAll, wilds);

      let bestFlushVec = null;
      let bestSFTop = 0;

      for(const s of SUITS){
        const suitNat = natCards.filter(c=>c.s===s).map(c=>c.r);
        const suitSet = new Set(suitNat);

        const sfTop = bestStraightTop(suitSet, wilds);
        if(sfTop > bestSFTop) bestSFTop = sfTop;

        if(suitNat.length + wilds >= 5){
          const sorted = suitNat.slice().sort((a,b)=>b-a);
          const vec = sorted.slice(0,5);
          for(let r=14; vec.length<5 && r>=2; r--) vec.push(r);
          if(!bestFlushVec || lexCompare(vec,bestFlushVec)>0) bestFlushVec = vec;
        }
      }

      let best = { ...bestGroupHandWithWildRanks(natRanks, wilds), used: cards5 };

      if(sTop){
        const cand={cat:4,name:"Straight",vec:[sTop],used:cards5};
        if(beats(cand,best)) best=cand;
      }
      if(bestFlushVec){
        const cand={cat:5,name:"Flush",vec:bestFlushVec,used:cards5};
        if(beats(cand,best)) best=cand;
      }
      if(bestSFTop){
        const sfName = (bestSFTop===14) ? "Royal Flush" : "Straight Flush";
        const cand={cat:8,name:sfName,vec:[bestSFTop],used:cards5};
        if(beats(cand,best)) best=cand;
      }

      return best;
    }

    function bestFromPool(pool, player){
      if(pool.length===0) return null;

      if(pool.length < 5){
        const w = pool.filter(c=>isWild(c,player)).length;
        const nat = pool.filter(c=>!isWild(c,player)).map(c=>c.r);

        let best=null;
        const assign=new Array(w).fill(2);

        function next(){
          for(let i=0;i<w;i++){
            if(assign[i]<14){ assign[i]++; return true; }
            assign[i]=2;
          }
          return false;
        }
        function score(eff){
          const cnt=new Map();
          eff.forEach(r=>cnt.set(r,(cnt.get(r)||0)+1));
          const uniq=[...cnt.keys()].sort((a,b)=>b-a);
          const groups=uniq.map(r=>({r,c:cnt.get(r)||0}))
            .sort((a,b)=>b.c-a.c||b.r-a.r);
          const flat=eff.slice().sort((a,b)=>b-a);

          if(groups[0].c===4) return {cat:7,name:"Four of a Kind",vec:[groups[0].r]};
          if(groups[0].c===3){
            const trips=groups[0].r;
            const kicker=flat.filter(x=>x!==trips)[0]||0;
            return {cat:3,name:"Three of a Kind",vec:[trips,kicker]};
          }
          if(groups[0].c===2 && groups[1]?.c===2){
            const a=groups[0].r,b=groups[1].r;
            return {cat:2,name:"Two Pair",vec:[Math.max(a,b),Math.min(a,b)]};
          }
          if(groups[0].c===2){
            const pair=groups[0].r;
            const kickers=flat.filter(x=>x!==pair).slice(0,pool.length-2);
            return {cat:1,name:"One Pair",vec:[pair,...kickers]};
          }
          return {cat:0,name:"High Card",vec:flat.slice(0,pool.length)};
        }

        while(true){
          const eff=nat.concat(assign);
          const s=score(eff);
          if(!best || beats(s,best)) best=s;
          if(!next()) break;
        }
        return {...best, used: pool.slice()};
      }

      const combos = chooseK(pool,5);
      let best=null;
      for(const c5 of combos){
        const h = evalFive(c5, player);
        if(!best || beats(h,best)) best=h;
      }
      return best;
    }

    // ------------------------------------------------------------
    // Core game logic
    // ------------------------------------------------------------
    function leftNeighborIndex(i){
      return (i + 1) % players.length;
    }

    function bestHandForPlayer(i){
      const p = players[i];

      const commPool = community.concat(p.revealed);
      const leftTrashPool = players[leftNeighborIndex(i)].trash.concat(p.revealed);

      const bestComm = bestFromPool(commPool, p);
      const bestTrash = bestFromPool(leftTrashPool, p);

      if(!bestComm && !bestTrash) return null;
      if(bestComm && !bestTrash){
        return { ...bestComm, sharedType:"community", sharedUsed: bestComm.used.filter(c=>community.includes(c)) };
      }
      if(bestTrash && !bestComm){
        const lt = players[leftNeighborIndex(i)].trash;
        return { ...bestTrash, sharedType:"trash", sharedUsed: bestTrash.used.filter(c=>lt.includes(c)), sharedOwner:leftNeighborIndex(i) };
      }

      if(beats(bestComm, bestTrash)){
        return { ...bestComm, sharedType:"community", sharedUsed: bestComm.used.filter(c=>community.includes(c)) };
      } else if(beats(bestTrash, bestComm)){
        const lt = players[leftNeighborIndex(i)].trash;
        return { ...bestTrash, sharedType:"trash", sharedUsed: bestTrash.used.filter(c=>lt.includes(c)), sharedOwner:leftNeighborIndex(i) };
      } else {
        return { ...bestComm, sharedType:"community", sharedUsed: bestComm.used.filter(c=>community.includes(c)) };
      }
    }

    function usingText(best, playerIndex){
      if(!best) return "";
      if(best.sharedType==="community") return "Using Community";
      if(best.sharedType==="trash"){
        const owner = (best.sharedOwner ?? leftNeighborIndex(playerIndex));
        return `Using Player ${owner+1} Trash`;
      }
      return "";
    }

    function displayName(best){
      if(!best) return "—";
      if(best.name==="Royal Flush") return "Royal Flush";
      const v=best.vec;
      switch(best.cat){
        case 1: return `One Pair (${RANK_NAME(v[0])}s)`;
        case 2: return `Two Pair (${RANK_NAME(v[0])}s & ${RANK_NAME(v[1])}s)`;
        case 3: return `Three of a Kind (${RANK_NAME(v[0])}s)`;
        case 4: return `Straight (${RANK_NAME(v[0])}-high)`;
        case 5: return `Flush (${RANK_NAME(v[0])}-high)`;
        case 6: return `Full House (${RANK_NAME(v[0])}s over ${RANK_NAME(v[1])}s)`;
        case 7: return `Four of a Kind (${RANK_NAME(v[0])}s)`;
        case 8: return `Straight Flush (${RANK_NAME(v[0])}-high)`;
        case 9: return `Five of a Kind (${RANK_NAME(v[0])}s)`;
        default: return best.name;
      }
    }

    function isFinished(i){
      const p = players[i];
      return p.revealed.length === MAX_REVEALED && p.trash.length === MAX_TRASH;
    }
    function allFinished(){
      return players.every((_,i)=>isFinished(i));
    }
    function allOthersFinished(i){
      for(let j=0;j<players.length;j++){
        if(j===i) continue;
        if(!isFinished(j)) return false;
      }
      return true;
    }

    function recompute(isInit=false){
      for(let i=0;i<players.length;i++){
        players[i].best = bestHandForPlayer(i);
      }

      leaderIndices=[];
      let top=null;
      for(let i=0;i<players.length;i++){
        const h=players[i].best;
        if(!h) continue;
        if(!top || beats(h,top)){
          top=h; leaderIndices=[i];
        } else if(equalHands(h,top)){
          leaderIndices.push(i);
        }
      }

      // new_leader only when the SINGLE leader player changes
      if(!isInit){
        if(leaderIndices.length === 1){
          const leaderNow = leaderIndices[0];
          if(lastSingleLeader !== null && leaderNow !== lastSingleLeader){
            playSfx("leader");
          }
          lastSingleLeader = leaderNow;
        } else {
          lastSingleLeader = null;
        }
      }

      if(allFinished() || deck.length===0){
        phase="DONE";
        if(!gameOverPlayed){
          playSfx("gameOver");
          gameOverPlayed = true;
        }
      }
    }

    function bestOpponentHand(excludeIndex){
      let opp=null;
      for(let i=0;i<players.length;i++){
        if(i===excludeIndex) continue;
        const h=players[i].best;
        if(!h) continue;
        if(!opp || beats(h,opp)) opp=h;
      }
      return opp;
    }

    function shouldStopTurn(i){
      const opp = bestOpponentHand(i);
      if(!opp) return true;
      const me = players[i].best;
      if(!me) return false;
      if(beats(me,opp)) return true;
      if(equalHands(me,opp) && isFinished(i)) return true;
      return false;
    }

    function needsTrashPick(i){
      const p = players[i];
      return p.revealed.length===4 && p.trash.length<3 && !p.trashNextDraw;
    }
    function mustPickTrashNow(i){
      return needsTrashPick(i) && (!shouldStopTurn(i) || allOthersFinished(i));
    }

    function canActBasic(i){
      if(deck.length===0) return false;
      if(isFinished(i)) return false;
      return true;
    }
    function anyNonLeaderCanAct(){
      for(let i=0;i<players.length;i++){
        if(leaderIndices.includes(i)) continue;
        if(canActBasic(i)) return true;
      }
      return false;
    }
    function canAct(i){
      if(phase==="DONE") return false;
      if(phase==="WAIT_NEXT") return false;

      if(openingLock){
        return i===0 && canActBasic(0);
      }
      if(!canActBasic(i)) return false;

      if(leaderIndices.includes(i) && anyNonLeaderCanAct()){
        return false;
      }
      return true;
    }

    function nextEligiblePlayer(startIndex){
      for(let step=1; step<=players.length; step++){
        const idx=(startIndex+step)%players.length;
        if(canAct(idx)) return idx;
      }
      return null;
    }

    // NEW: request Next pause to a specific target player (no silent turn switches)
    function requestAdvanceToPlayer(targetIdx){
      if(targetIdx === null || targetIdx === undefined) return;
      if(targetIdx === current) return;
      pendingAdvance = targetIdx;
      phase = "WAIT_NEXT";
      playSfx("turn");
    }

    function ensureCurrentEligible(){
      if(phase==="DONE" || phase==="WAIT_NEXT") return;
      if(openingLock){
        current = 0;
        return;
      }
      if(canAct(current)) return;

      const nxt = nextEligiblePlayer(current);
      if(nxt!==null){
        // NEW: don't silently switch turns; require Next
        requestAdvanceToPlayer(nxt);
        return;
      }

      if(!allFinished() && deck.length>0){
        const alt = players.findIndex((_,i)=>canActBasic(i));
        if(alt>=0){
          // NEW: don't silently switch turns; require Next
          requestAdvanceToPlayer(alt);
          return;
        }
      }

      if(allFinished() || deck.length===0) phase="DONE";
    }

    // End-of-turn now waits for Next
    function requestAdvanceToNextPlayer(){
      let nxt = nextEligiblePlayer(current);
      if(nxt === null){
        if(!allFinished() && deck.length>0){
          const alt = players.findIndex((_,i)=>canActBasic(i));
          if(alt>=0) nxt = alt;
        }
      }

      if(nxt === null){
        if(allFinished() || deck.length===0) phase="DONE";
        return;
      }

      pendingAdvance = nxt;
      phase = "WAIT_NEXT";
      playSfx("turn");
    }

    nextBtn.addEventListener("click", () => {
      if(phase !== "WAIT_NEXT") return;
      if(pendingAdvance === null) return;

      current = pendingAdvance;
      pendingAdvance = null;
      phase = "DRAW";

      afterState();
      render();
    });

    // ------------------------------------------------------------
    // Command panel (trash + replacement)
    // ------------------------------------------------------------
    function beginReplacement(triggerCard){
      const options=[];
      for(let i=0;i<3 && deck.length>0;i++) options.push(deck.pop());
      replaceCtx = { playerIndex: current, triggerCard, options, pickedIndex: null };
      phase = "REPLACE_PICK";
      playSfx("replace");

      // NEW: ensure the computer continues through replacement steps
      if(isAIPlayer(current)){
        scheduleAI(AI_STEP_MS);
      }
    }

    // after replacement resolves/skip, check if the turn should end -> WAIT_NEXT
    function finishTurnCheckAfterSpecial(){
      if(phase==="DONE") return;
      if(isFinished(current)){
        requestAdvanceToNextPlayer();
        return;
      }
      if(shouldStopTurn(current) && !allOthersFinished(current)){
        requestAdvanceToNextPlayer();
        return;
      }
    }

    function skipReplacement(){
      replaceCtx = null;
      phase = "DRAW";
      recompute(false);

      // ensure Next isn't skipped when replacement ends a turn
      finishTurnCheckAfterSpecial();

      afterState();
      render();
    }
    function commitReplacement(targetIndex){
      const opt = replaceCtx.options[replaceCtx.pickedIndex];
      community[targetIndex] = opt;
      replaceCtx = null;
      phase = "DRAW";
      recompute(false);

      // ensure Next isn't skipped when replacement ends a turn
      finishTurnCheckAfterSpecial();

      afterState();
      render();
    }

    function beginTrashPick(){
      phase="TRASH_PICK";
      playSfx("trash");
      render();
    }
    function commitTrashPick(choice){
      const p = players[current];

      if(p.trash.length >= 3){
        p.trashNextDraw = false;
        phase="DRAW";
        render();
        return;
      }

      if(choice.type==="revealed"){
        if(choice.index < 0 || choice.index >= p.revealed.length) return;
        const [card] = p.revealed.splice(choice.index, 1);
        p.trash.push(card);
        p.trashNextDraw = false;
      } else {
        p.trashNextDraw = true;
      }

      recompute(false);
      if(phase!=="DONE") phase="DRAW";
      afterState();
      render();
    }

    commandChoices.addEventListener("click", (e)=>{
      const t = e.target.closest("[data-action]");
      if(!t) return;
      const action = t.getAttribute("data-action");

      if(phase==="TRASH_PICK"){
        if(action==="trashRevealed"){
          commitTrashPick({type:"revealed", index:Number(t.getAttribute("data-index"))});
        } else if(action==="trashUnknown"){
          commitTrashPick({type:"unknown"});
        }
        return;
      }

      if(phase==="REPLACE_PICK" || phase==="REPLACE_TARGET"){
        if(action==="skipReplace"){
          skipReplacement();
          return;
        }
        if(action==="pickReplace" && phase==="REPLACE_PICK"){
          replaceCtx.pickedIndex = Number(t.getAttribute("data-index"));
          phase="REPLACE_TARGET";
          render();
          return;
        }
      }
    });

    communityCardsEl.addEventListener("click", (e)=>{
      if(phase!=="REPLACE_TARGET") return;
      const t = e.target.closest("[data-idx]");
      if(!t) return;
      commitReplacement(Number(t.getAttribute("data-idx")));
    });

    function afterState(){
      if(phase==="DONE" || phase==="WAIT_NEXT") return;

      ensureCurrentEligible();
      if(phase==="DONE" || phase==="WAIT_NEXT") return;

      if(phase==="DRAW" && mustPickTrashNow(current)){
  beginTrashPick();
  return;
}

    }

    // ------------------------------------------------------------
    // AI (Player 2 only in 2-player mode)
    // ------------------------------------------------------------
    function chooseTrashIndexHeuristic(){
      const p = players[current];

      const allPower = p.revealed.every(c => isWild(c, p));
      if(allPower) return {type:"unknown"};

      let best = {idx:0, score:Infinity};
      for(let i=0;i<p.revealed.length;i++){
        const c = p.revealed[i];
        if(isWild(c, p)) continue;
        const score = c.r;
        if(score < best.score){
          best = {idx:i, score};
        }
      }

      if(best.score !== Infinity){
        return {type:"revealed", index: best.idx};
      }
      return {type:"unknown"};
    }

    function scoreHand(h){
      if(!h) return -1e18;
      let s = h.cat * 1e9;
      for(let i=0;i<h.vec.length;i++){
        s += (h.vec[i]||0) * Math.pow(1000, (5-i));
      }
      return s;
    }

    function aiPlanReplacement(){
      const aiIndex = current;
      const humanIndex = 0;

      let best = {opt:0, tgt:0, score:-Infinity};

      for(let oi=0; oi<replaceCtx.options.length; oi++){
        const optCard = replaceCtx.options[oi];

        for(let ti=0; ti<community.length; ti++){
          const old = community[ti];
          community[ti] = optCard;

          const aiH = bestHandForPlayer(aiIndex);
          const huH = bestHandForPlayer(humanIndex);

          const sc = scoreHand(aiH) - 0.8*scoreHand(huH);
          if(sc > best.score){
            best = {opt:oi, tgt:ti, score:sc};
          }

          community[ti] = old;
        }
      }
      return best;
    }

    function aiStepOnce(){
      if(phase==="DONE" || phase==="WAIT_NEXT") return;
      if(!isAIPlayer(current)) return;
      if(revealDelayActive) return;

	if(phase === "DRAW"){
  	  ensureCurrentEligible();
  	  if(phase==="WAIT_NEXT" || !isAIPlayer(current)) return;
	}

      if(phase==="TRASH_PICK"){
        const pick = chooseTrashIndexHeuristic();
        if(pick.type==="unknown") commitTrashPick({type:"unknown"});
        else commitTrashPick({type:"revealed", index: pick.index});
        return;
      }

      if(phase==="REPLACE_PICK"){
        const plan = aiPlanReplacement();
        replaceCtx.pickedIndex = plan.opt;
        phase = "REPLACE_TARGET";
        render();
        scheduleAI(AI_STEP_MS);
        return;
      }

      if(phase==="REPLACE_TARGET"){
        const plan = aiPlanReplacement();
        commitReplacement(plan.tgt);
        return;
      }

      if(phase==="DRAW"){
        drawOneInternal();
        return;
      }
    }

    function maybeAutoPlay(){
      if(phase==="DONE" || phase==="WAIT_NEXT") return;
      if(!isAIPlayer(current)) return;
      if(revealDelayActive) return;

      aiStepOnce();

      if(phase !== "DONE" && phase !== "WAIT_NEXT" && isAIPlayer(current)){
        scheduleAI(AI_STEP_MS);
      }
    }

    // ------------------------------------------------------------
    // Draw (single action) with 550ms reveal delay after play sound
    // ------------------------------------------------------------
    function drawOneInternal(){
      if(phase!=="DRAW") return;
      if(revealDelayActive) return;

      ensureCurrentEligible();
      if(phase==="DONE" || phase==="WAIT_NEXT"){ render(); return; }
      if(!canAct(current)){ render(); return; }
      if(deck.length===0){ recompute(false); render(); return; }

      const p = players[current];

      if(mustPickTrashNow(current)){
        beginTrashPick();
        return;
      }

      // Pop the card immediately, but don't show/apply it yet
      const drawn = deck.pop();

      // Play sound immediately
      playSfx("play");

      // Lock inputs and render (buttons will disable)
      revealDelayActive = true;
      render();

      // After delay, apply card and proceed with existing logic
      revealTimer = setTimeout(() => {
        revealTimer = null;
        revealDelayActive = false;

        if(phase !== "DRAW") { render(); return; } // safety

        if(p.trashNextDraw){
          p.trashNextDraw = false;

          if(p.trash.length < 3){
            p.trash.push(drawn);
          } else if(p.revealed.length < 4){
            p.revealed.push(drawn);
          }

          recompute(false);

          if(phase!=="DONE"){
            if(isFinished(current)){
              requestAdvanceToNextPlayer();
            } else if(shouldStopTurn(current) && !allOthersFinished(current)){
              requestAdvanceToNextPlayer();
            }
            afterState();
          }

          render();
          return;
        }

        const wasRevealed = (p.revealed.length < 4);
        if(wasRevealed){
          p.revealed.push(drawn);
          if(current===0 && openingLock && p.revealed.length>=1){
            openingLock = false;
          }
        } else {
          if(p.trash.length < 3) p.trash.push(drawn);
        }

        recompute(false);

        if(wasRevealed && isReplacementTrigger(drawn) && phase!=="DONE"){
          beginReplacement(drawn);
          render();
          return;
        }

        if(phase!=="DONE"){
          if(isFinished(current)){
            requestAdvanceToNextPlayer();
            afterState();
            render();
            return;
          }

          if(mustPickTrashNow(current)){
            beginTrashPick();
            return;
          }

          if(shouldStopTurn(current) && !allOthersFinished(current)){
            requestAdvanceToNextPlayer();
            afterState();
            render();
            return;
          }

          afterState();
        }

        render();
      }, CARD_REVEAL_DELAY_MS);
    }

    drawBtn.addEventListener("click", () => {
      if(isAIPlayer(current)) return;
      drawOneInternal();
    });

    // ------------------------------------------------------------
    // Render
    // ------------------------------------------------------------
    function renderCommunity(){
      const vIdx = viewPlayerIndex();
      const pView = players[vIdx];

      const leftIdx = leftNeighborIndex(vIdx);
      const availableTrash = players[leftIdx].trash;

      availableTrashLabelEl.textContent = `Available Trash (P${leftIdx+1})`;

      const sharedType = pView.best?.sharedType;
      if(sharedType==="community") choiceLabelEl.textContent = "Using: Community";
      else if(sharedType==="trash") choiceLabelEl.textContent = "Using: Available Trash";
      else choiceLabelEl.textContent = "";

      const sharedUsedSet = new Set(pView.best?.sharedUsed ?? []);

      communityCardsEl.innerHTML = community.map((c,idx)=>{
        const wild = isWild(c,pView);
        const used = (sharedType==="community") && sharedUsedSet.has(c);
        const clickable = (phase==="REPLACE_TARGET") ? " clickable" : "";
        const data = (phase==="REPLACE_TARGET") ? `data-idx="${idx}"` : "";
        return `<div class="card ${wild?"wild":""} ${used?"best":""}${clickable}" ${data}>${cardHTML(c)}</div>`;
      }).join("");

      availableTrashCardsEl.innerHTML = availableTrash.map((c)=>{
        const wild = isWild(c,pView);
        const used = (sharedType==="trash") && sharedUsedSet.has(c);
        return `<div class="card ${wild?"wild":""} ${used?"best":""}">${cardHTML(c)}</div>`;
      }).join("");
    }

    function renderPlayers(){
      for(let i=0;i<numPlayers;i++){
        const p=players[i];
        const el=pEls[i];

        el.classList.toggle("active", i===current);
        el.classList.toggle("previewHover", hoveredPlayer===i);

        let leaderTag="";
        if(leaderIndices.includes(i)){
          leaderTag = (leaderIndices.length>1) ? " — LEADER (TIED)" : " — LEADER";
        }

        const wildText = (p.wildType==="odd")
          ? "Wild: ♦3 ♦5 ♦7 + Jkr"
          : "Wild: ♦2 ♦4 ♦6 + Jkr";

        const bestText = displayName(p.best);
        const usingLine = usingText(p.best, i);

        const usedSet = new Set(p.best?.used ?? []);
        const showBest = (i === current || i === hoveredPlayer);

        let status="";
        if(phase==="DONE"){
          status = leaderIndices.length
            ? (leaderIndices.length===1
                ? `Round complete. Winner: Player ${leaderIndices[0]+1}.`
                : `Round complete. Winners (tied): ${leaderIndices.map(i=>`Player ${i+1}`).join(" & ")}.`)
            : "Round complete.";
        } else if(i===current){
          if(openingLock && i===0) status="Opening: Player 1 reveals first.";
          else if(phase==="WAIT_NEXT") status="Turn ended. Click Next.";
          else if(phase==="REPLACE_PICK" || phase==="REPLACE_TARGET") status="Resolve community replacement (see panel upper-right).";
          else if(phase==="TRASH_PICK") status="Select a trash option (see panel upper-right).";
          else if(players[current].trashNextDraw) status="Next draw will go to Trash (unknown selected).";
          else status = isAIPlayer(i) ? "Computer playing…" : "Click Draw to continue.";
        }

        el.innerHTML = `
          <div class="header">
            <div>Player ${i+1}${leaderTag}${isAIPlayer(i) ? " (Computer)" : ""}</div>
            <div class="rightInfo">
              <div class="handLine">${bestText}</div>
              <div class="usingLine">${usingLine || ""}</div>
            </div>
          </div>
          <div class="sub">${wildText}</div>

          <div class="row">
            <div class="rowLabel">
              Revealed
              <span class="count">${p.revealed.length}/4</span>
            </div>
            <div class="cards">
              ${p.revealed.map(c=>{
                const wild=isWild(c,p);
                const used = showBest && usedSet.has(c);
                return `<div class="card ${wild?"wild":""} ${used?"best":""}">${cardHTML(c)}</div>`;
              }).join("")}
            </div>
          </div>

          <div class="row">
            <div class="rowLabel">
              Trash
              <span class="count">${p.trash.length}/3</span>
            </div>
            <div class="cards">
              ${p.trash.map(c=>`<div class="card">${cardHTML(c)}</div>`).join("")}
            </div>
          </div>

          <div class="status">${status}</div>
        `;
      }
    }

    function renderCommandPanel(){
      if(phase==="REPLACE_PICK" && replaceCtx){
        const text =
          `Community card replacement triggered by ${cardText(replaceCtx.triggerCard)}.\n` +
          `Select 1 of 3 below.`;

        const choices =
          replaceCtx.options.map((c,idx)=>
            `<div class="card clickable" data-action="pickReplace" data-index="${idx}">${cardHTML(c)}</div>`
          ).join("") +
          `<button class="miniBtn" data-action="skipReplace">Skip Replacement</button>`;

        commandPanel.style.display="block";
        commandText.textContent=text;
        commandChoices.innerHTML=choices;
        return;
      }

      if(phase==="REPLACE_TARGET" && replaceCtx){
        const picked = replaceCtx.options[replaceCtx.pickedIndex];
        const text =
          `Replace with ${cardText(picked)}.\n` +
          `Click a community card to replace.`;

        commandPanel.style.display="block";
        commandText.textContent=text;
        commandChoices.innerHTML=`<button class="miniBtn" data-action="skipReplace">Skip Replacement</button>`;
        return;
      }

      if(phase==="TRASH_PICK"){
        const p = players[current];
        const text =
          "Trash selection required.\n" +
          "Choose 1 of your 4 revealed cards OR choose the unknown next card.";

        const revealedChoices = p.revealed.map((c,idx)=>
          `<div class="card clickable" data-action="trashRevealed" data-index="${idx}">${cardHTML(c)}</div>`
        ).join("");

        const unknownChoice =
          `<div class="pill" data-action="trashUnknown">Trash the unknown next card</div>`;

        commandPanel.style.display="block";
        commandText.textContent=text;
        commandChoices.innerHTML=revealedChoices + unknownChoice;
        return;
      }

      commandPanel.style.display = "none";
      commandText.textContent = "";
      commandChoices.innerHTML = "";
    }

    function render(){
      if(phase === "DRAW"){
        ensureCurrentEligible();
        if(phase==="DRAW" && mustPickTrashNow(current)){
  beginTrashPick();
  return;
}

      }

      renderCommunity();
      renderPlayers();
      renderCommandPanel();

      const disableBecauseAI = isAIPlayer(current);

      drawBtn.disabled =
        revealDelayActive ||
        disableBecauseAI ||
        (phase !== "DRAW") ||
        (phase==="DRAW" && mustPickTrashNow(current)) ||
        !canAct(current);

      nextBtn.disabled = (phase !== "WAIT_NEXT");

      if(disableBecauseAI && phase !== "WAIT_NEXT"){
        scheduleAI(AI_STEP_MS);
      }
    }

    // ------------------------------------------------------------
    // Start game
    // ------------------------------------------------------------
    initGame(numPlayers);

  } catch (err) {
    showError(err);
  }
})();
