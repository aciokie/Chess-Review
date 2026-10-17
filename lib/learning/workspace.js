import {Chess} from '../chess.js';
import {LESSONS, OPENINGS, CATEGORIES, DIFFICULTIES, THEME_NAMES, playUci, linePositions, positionKey} from './content.js';
import {validateExercise, validatePuzzleMove, validSquares} from './validation.js';
import {ProgressStore, progressTotals, recordPuzzle, ChallengeClock, challengeResult} from './progress.js';
import {moveEvents} from '../concepts/detectors/E022-tactics.mjs';
import {explainMove} from '../concepts/detectors/E020-concepts.mjs';
import {capturePanels, morphPanels} from './morph.js';
import {LEARNING_PRESENTATIONS, presentationFor, presentationHome, presentationChrome} from './presentations.js';

const NAMES = {p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'};
const themeLesson = {fork:'fork',pin:'pin',skewer:'skewer',discoveredAttack:'discovery',mateIn1:'mate',mateIn2:'mate',backRankMate:'back-rank',defensiveMove:'escape',promotion:'promotion',hangingPiece:'loose-pieces',endgame:'passer',sacrifice:'loose-pieces'};
export function puzzleExplanation(puzzle) {
  const c = new Chess(puzzle.fen), notes = [];
  for (let i = 0; i < puzzle.solution.length; i++) {
    const before = new Chess(c.fen());
    const m = playUci(c, puzzle.solution[i]);
    let text = `${i % 2 ? 'Opponent' : 'You'}: ${m.san}. `;
    if (m.captured) text += `The ${NAMES[m.piece]} captures the ${NAMES[m.captured]} on ${m.isEnPassant() ? m.to[0]+m.from[1] : m.to}. `;
    else text += `The ${NAMES[m.piece]} moves from ${m.from} to ${m.to}. `;
    if (m.promotion) text += `The pawn promotes to a ${NAMES[m.promotion]}. `;
    if (c.isCheckmate()) text += 'The king is in check and has no legal response: checkmate.';
    else if (c.isCheck()) text += 'Check forces the next reply to address the king threat. ';
    if (!(i % 2) && puzzle.themes.includes('fork')) {
      const targets = c.board().flat().filter(p=>p && p.color!==m.color && c.attackers(p.square,m.color).includes(m.to));
      if (targets.length >= 2) text += `This attacks ${targets.map(p=>`the ${NAMES[p.type]} on ${p.square}`).join(' and ')} at once. `;
    }
    if (!(i % 2)) {
      const facts = moveEvents(before,c,m,{maxTacticNodes:2000}).events;
      for (const event of facts.filter(e=>['discovered-attack','absolute-skewer','profitable-capture','winning-exchange','interposition','capture-checker','back-rank-mate','smothered-mate'].includes(e.id))) text += event.text + ' ';
      if (puzzle.themes.includes('pin')) {
        const pin = explainMove({fen:before.fen(),move:m.lan,scanReplies:false,maxNodes:2000}).events.find(e=>e.id==='absolute-pin');
        if(pin)text += pin.text + ' ';
      }
      if(puzzle.themes.includes('sacrifice')&&c.moves({verbose:true}).some(reply=>reply.captured&&reply.to===m.to)) text += `The ${NAMES[m.promotion||m.piece]} is offered on ${m.to}; follow the forcing continuation before judging the material trade. `;
    }
    notes.push(text.trim());
  }
  return notes;
}

export class LearningWorkspace {
  static presentations = LEARNING_PRESENTATIONS;
  static presentationFor = presentationFor;
  constructor({document = globalThis.document, storage, makePiece, url = p=>p, settings = ()=>({}), flipped = false, onClose = ()=>{}, book = ()=>({}), embedded = null}) {
    this.doc = document; this.store = new ProgressStore(storage, document.defaultView?.navigator?.locks);
    this.makePiece = makePiece; this.url = url; this.settings = settings; this.flipped = flipped; this.onClose = onClose; this.book = book;
    this.embedded = embedded;
    this.presentation = embedded ? presentationFor(settings()) : 'page';
    this.reviewFlipped = flipped;
    this.page = 'home'; this.activity = null; this.filters = {search:'',category:'All',difficulty:'All',theme:'All',phase:'All',status:'All',family:'All',color:'Both',bookmarks:false};
    this.selected = null; this.marked = new Set(); this.feedback = null; this.busy = false; this.closed = false; this.generation = 0;
    this.run = null; this.worker = null; this.workerSeq = 0; this.workerPending = new Map();
    this.h = (tag, attrs = {}, ...children) => {
      const node = this.doc.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (key === 'disabled') node.disabled = !!value;
        else node.setAttribute(key, value);
      }
      for (const child of children.flat()) if (child != null && child !== false) node.append(child.nodeType ? child : this.doc.createTextNode(String(child)));
      return node;
    };
  }
  button(label, action, attrs = {}) {return this.h('button', {type:'button', class:'learn-button', 'data-focus':'button-'+label, onclick:action, ...attrs}, label);}
  p(text, cls = '') {return this.h('p', {class:cls}, text);}
  heading(text) {return this.h('h2', {}, text);}
  async open() {
    this.previousFocus = this.doc.activeElement;
    this.background = this.doc.querySelector('#root > .app');
    this.backgroundInert = this.background?.inert;
    this.oldOverflow = this.doc.body.style.overflow;
    this.root = this.h('section', {class:'learning-workspace'+(this.embedded?' learning-embedded':''), role:this.embedded?'region':'dialog', 'aria-modal':this.embedded?null:'true', 'aria-label':'Learn with Chess Review', 'data-presentation':this.presentation, 'data-motion':this.settings().moveAnim===false?'off':'on'});
    if (this.embedded) this.mountEmbedded();
    else {if (this.background) this.background.inert = true; this.doc.body.style.overflow = 'hidden'; this.doc.body.append(this.root);}
    this.keyHandler = e => this.onKey(e); this.doc.addEventListener('keydown', this.keyHandler, true);
    this.ready = false; this.render();
    const loading = this.load();
    if (this.embedded) {
      this.transitioning = true;
      await loading;
      if (!this.closed && !this.closing) {
        this.shell.style.visibility = '';
        this.shell.querySelector('[data-focus="review"]')?.focus();
        await (this.morph = this.transitionPanels(this.reviewSurfaces, this.panelSurfaces()));
      }
      this.transitioning = false;
    } else await loading;
  }
  mountEmbedded() {
    const {stage, boardWrap} = this.embedded;
    this.reviewNodes = [...stage.querySelectorAll('.mod:not([data-mod="board"]) > .mod-inner'), this.doc.querySelector('#playerTop'), this.doc.querySelector('#playerBot')].filter(Boolean);
    this.reviewSurfaces = capturePanels(this.reviewNodes);
    this.boardElement = boardWrap.querySelector('.board');
    this.boardOriginalClass = this.boardElement.className;
    this.boardOriginalInert = this.boardElement.inert;
    this.boardChildren = [...this.boardElement.childNodes];
    this.boardExtras = [...boardWrap.children].filter(node => node !== this.boardElement);
    this.boardExtras.forEach(node => node.remove());
    this.placeholder = this.h('div', {class:'board-wrap learn-board-placeholder', 'aria-hidden':'true'});
    boardWrap.replaceWith(this.placeholder);
    this.dock = this.h('div', {class:'learn-board-dock'}, boardWrap);
    this.boardInfo = this.h('div', {class:'learn-dock-info'});
    this.dock.append(this.boardInfo);
    this.shell = this.h('div', {class:'learn-shell'});
    this.shell.style.visibility = 'hidden';
    this.root.append(this.dock, this.shell); stage.append(this.root);
    this.inertNodes = [...stage.querySelectorAll('.mod'), this.background?.querySelector('.library-rail')].filter(Boolean).map(node => ({node, inert:node.inert}));
    this.inertNodes.forEach(({node}) => {node.inert = true;});
    stage.classList.add('learning-active'); this.background?.classList.add('has-learning');
    this.positionEmbedded = () => {
      const bounds = stage.getBoundingClientRect(), slot = this.placeholder.getBoundingClientRect();
      const size = Math.min(slot.width, slot.height) || Math.min(560, bounds.width-32);
      const left = slot.x-bounds.x+(slot.width-size)/2, top = slot.y-bounds.y;
      this.root.style.setProperty('--learn-board-x', left+'px');
      this.root.style.setProperty('--learn-board-y', top+'px');
      this.root.style.setProperty('--learn-board-size', size+'px');
      const right = left+size+28, leftRoom = left-40, rightRoom = bounds.width-right-20;
      const stacked = Math.max(leftRoom,rightRoom)<340;
      this.root.classList.toggle('learn-stacked', stacked);
      this.root.style.setProperty('--learn-panel-x', (stacked?16:rightRoom>=leftRoom?right:20)+'px');
      this.root.style.setProperty('--learn-panel-y', (stacked?top+size+76:Math.max(12,top-(this.presentation==='morph'?48:0)))+'px');
      this.root.style.setProperty('--learn-panel-width', (stacked?bounds.width-32:Math.min(Math.max(leftRoom,rightRoom),this.presentation==='minimal'?760:this.presentation==='board'?800:Infinity))+'px');
      this.root.style.setProperty('--learn-panel-height', Math.max(360,Math.min(size,this.doc.defaultView.innerHeight-slot.top-28))+'px');
      this.root.style.minHeight = Math.max(top+size+100, stacked?top+size+600:680)+'px';
    };
    this.positionEmbedded();
    this.doc.defaultView.addEventListener('resize', this.positionEmbedded);
    if (this.doc.defaultView.ResizeObserver) {
      this.resizeObserver = new this.doc.defaultView.ResizeObserver(this.positionEmbedded);
      this.resizeObserver.observe(this.placeholder);
    }
  }
  panelSurfaces() {
    const selectors = this.presentation==='studio' ? '.learn-header, .learn-nav, .learn-main'
      : '.learn-header, .learn-nav, .learn-hero, .learn-stats, .destinations > .learn-card, .learn-main > div > .learn-panel, .learn-activity-head, .learn-study > .learn-panel, .learn-desk-footer, .studio-destinations, .studio-next, .studio-footer';
    return this.root.querySelectorAll(selectors);
  }
  transitionPanels(sources, targets) {
    return morphPanels(this.doc,sources,targets,{variant:this.presentation,reduced:this.presentation!=='morph'&&this.settings().moveAnim===false});
  }
  unmountEmbedded() {
    this.doc.defaultView.removeEventListener('resize', this.positionEmbedded); this.resizeObserver?.disconnect();
    const {stage, boardWrap} = this.embedded;
    this.boardElement.className = this.boardOriginalClass;
    this.boardElement.inert = this.boardOriginalInert || false;
    this.boardElement.removeAttribute('aria-label');
    this.boardElement.replaceChildren(...this.boardChildren);
    boardWrap.append(...this.boardExtras); this.placeholder.replaceWith(boardWrap);
    this.inertNodes.forEach(({node, inert}) => {node.inert = inert || false;});
    stage.classList.remove('learning-active'); this.background?.classList.remove('has-learning');
  }
  async load() {
    this.loadError = null; this.ready = false; this.render();
    try {
      const [response] = await Promise.all([fetch(this.url('data/learning/puzzles.json')), this.store.load()]);
      if (!response.ok) throw Error('Puzzle library could not be read.');
      const data = await response.json();
      if (data.schema !== 1 || !Array.isArray(data.puzzles) || !data.puzzles.length) throw Error('Puzzle library has an unsupported format.');
      this.puzzles = data.puzzles; this.ready = true;
    } catch (error) {this.loadError = error.message;}
    if (!this.closed) this.render();
  }
  async save(change) {
    try {await this.store.update(change); return true;} catch {return false;}
  }
  close() {return this.closePromise ||= this.finishClose();}
  async finishClose() {
    if (this.closed || this.closing) return;
    this.closing = true;
    // Commit the active challenge before leaving; the review can return immediately.
    if (this.run) await this.finishChallenge('Ended on return to review', false);
    this.closed = true; this.generation++; clearInterval(this.ticker); this.stopWorker();
    this.doc.removeEventListener('keydown', this.keyHandler, true);
    if (this.embedded) {
      await this.morph;
      const surfaces = capturePanels(this.panelSurfaces());
      // Hide the learning surface, restore the real review, then animate between them.
      this.root.style.visibility = 'hidden';
      this.unmountEmbedded();
      await this.transitionPanels(surfaces, this.reviewNodes);
    } else {
      if (this.background) this.background.inert = this.backgroundInert || false;
      this.doc.body.style.overflow = this.oldOverflow;
    }
    this.root.remove(); this.previousFocus?.focus(); this.onClose();
  }
  flipBoard() {
    if (this.closed || this.closing) return;
    if (this.activity) this.flipped = !this.flipped;
    else {this.homeBoardFlipped = !this.homeBoardFlipped; this.flipped = this.homeBoardFlipped ? !this.reviewFlipped : this.reviewFlipped;}
    this.render();
  }
  stopWorker() {
    this.worker?.terminate(); this.worker = null;
    for (const resolve of this.workerPending.values()) resolve({status:'inconclusive',feedback:'Validation was interrupted; no incorrect answer was recorded.'});
    this.workerPending.clear();
  }
  onKey(e) {
    if (this.closed) return;
    if (e.key === 'Escape') {e.preventDefault(); e.stopImmediatePropagation(); if (this.selected || this.marked.size) {this.selected = null; this.marked.clear(); this.render();} else this.close(); return;}
    if (e.key === 'Tab' && !this.embedded) {
      const controls = [...this.root.querySelectorAll('button:not(:disabled), input, select, a[href]')].filter(n=>n.tabIndex>=0);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && (this.doc.activeElement === first || !this.root.contains(this.doc.activeElement))) {e.preventDefault(); last?.focus();}
      else if (!e.shiftKey && this.doc.activeElement === last) {e.preventDefault(); first?.focus();}
    }
    // Preserve review keyboard state while learning owns focus.
    if (!this.root.contains(e.target)) {if (!this.embedded) e.stopImmediatePropagation(); return;}
    if (e.target.closest('.learn-board') && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
      e.preventDefault(); const nodes = [...this.root.querySelectorAll('.learn-square')], index = nodes.indexOf(e.target.closest('.learn-square'));
      const offset = {ArrowLeft:-1,ArrowRight:1,ArrowUp:-8,ArrowDown:8}[e.key]; const next = nodes[index+offset];
      if (next) {nodes.forEach(n=>n.tabIndex=-1); next.tabIndex=0; next.focus(); this.boardFocus=next.dataset.square;}
    }
  }
  async navigate(page) {
    if (this.busy || this.run || this.closing) return;
    this.generation++; this.page = page; this.activity = null; this.result=null; this.clearAnswer();
    this.filters.search = ''; this.filters.status = 'All'; await this.store.load(); if (!this.closed) {this.scrollToTop();this.render();}
  }
  scrollToTop(showBoard = false) {
    if (!this.embedded) {this.root.scrollTop = 0; return;}
    this.shell.scrollTop = 0;
    const main = this.shell.querySelector('.learn-main'); if (main) main.scrollTop = 0;
    if (this.root.classList.contains('learn-stacked') && this.doc.defaultView.scrollY > 0) {
      (showBoard ? this.dock : this.shell).scrollIntoView?.({block:'start'});
    }
  }
  render() {
    if (this.closed || !this.root) return;
    const h = this.h, focused = this.doc.activeElement, focusKey = focused?.dataset?.focus;
    const selection = focused?.tagName === 'INPUT' ? [focused.selectionStart, focused.selectionEnd] : null;
    const header = h('header', {class:'learn-header'}, h('div', {class:'learn-brand'}, h('img',{src:this.url('pieces-img/cburnett/wN.svg'),alt:''}), h('span',{},'Learn with Chess Review')),
      this.button('← Back to review', ()=>this.close(), {'data-focus':'review'}));
    const compact=this.embedded && this.presentation!=='morph';
    const nav = h('nav',{class:'learn-nav','aria-label':'Learning destinations'}, ...[['home',compact?'Overview':'Learning home'],['puzzles','Puzzles'],['concepts',compact?'Concepts':'Chess Concepts'],['openings',this.presentation==='minimal'?'Opening theory':'Openings']].map(([id,label])=>
      this.button(label,()=>this.navigate(id), {'aria-current':this.page===id?'page':null,disabled:!!this.run||this.busy,'data-focus':id})));
    const main = h('main',{class:'learn-main'});
    if (!this.ready) main.append(h('div',{class:'learn-empty',role:'status'}, this.heading(this.loadError?'Learning could not load':'Preparing your learning workspace…'), this.p(this.loadError||'Loading your saved progress and offline library.'), this.loadError && this.button('Try again',()=>this.load())));
    else {
      if (this.store.error) main.append(h('div',{class:'learn-storage-error',role:'alert'}, 'Your progress could not be saved or loaded. Practice is still available. ',this.button('Retry saving',async()=>{await this.retrySave(); this.render();})));
      if (this.result) main.append(this.resultView());
      else if (this.activity?.kind === 'lesson') main.append(this.lessonView());
      else if (this.activity?.kind === 'opening') main.append(this.openingView());
      else if (this.activity?.kind === 'puzzle') main.append(this.puzzleView());
      else if (this.page === 'home') main.append(this.homeView());
      else if (this.page === 'concepts') main.append(this.conceptsView());
      else if (this.page === 'openings') main.append(this.openingsView());
      else main.append(this.puzzlesView());
    }
    if (this.embedded) {
      const column = main.querySelector('.learn-board-column') || (this.homeBoardFlipped && this.embedded.fen ? this.board(this.embedded.fen) : null);
      if (column) {
        const board = column.querySelector('.learn-board');
        this.boardElement.className = this.boardOriginalClass+' learn-board';
        this.boardElement.setAttribute('aria-label', board.getAttribute('aria-label'));
        this.boardElement.replaceChildren(...board.childNodes);
        this.boardInfo.replaceChildren(...[...column.children].filter(node=>node!==board));
        column.remove();
      } else {
        this.boardElement.className = this.boardOriginalClass;
        this.boardElement.removeAttribute('aria-label');
        this.boardElement.replaceChildren(...this.boardChildren);
        this.boardElement.inert = true;
        this.boardInfo.replaceChildren(h('span',{class:'learn-eyebrow'},'YOUR BOARD. NEW POSSIBILITIES.'),this.p('Choose a puzzle, concept or opening to begin.'));
      }
      if(column) this.boardElement.inert = false;
      const mainScroll = this.shell.querySelector('.learn-main')?.scrollTop || 0;
      this.shell.replaceChildren(...presentationChrome(this,header,nav,main));
      main.scrollTop = mainScroll;
      this.root.dataset.destination = this.page;
    } else this.root.replaceChildren(header, nav, main);
    const target = focusKey && [...this.root.querySelectorAll('[data-focus]')].find(n=>n.dataset.focus===focusKey);
    if (target) {target.focus(); if (selection && target.setSelectionRange) target.setSelectionRange(...selection);}
    else if (!this.root.contains(this.doc.activeElement)) (this.embedded?this.shell:header).querySelector('.learn-header button, button')?.focus();
  }
  async retrySave() {
    if (this.failedChanges?.length) {
      const changes = this.failedChanges; this.failedChanges = [];
      for (let i=0;i<changes.length;i++) if (!(await this.persist(changes[i]))) {this.failedChanges.push(...changes.slice(i+1));break;}
    } else await this.store.load();
  }
  async persist(change) {
    const saved = await this.save(change);
    if (!saved) (this.failedChanges ||= []).push(change);
    return saved;
  }
  status(kind, id) {return this.store.value[kind][id]?.status || 'not started';}
  homeView() {
    const alternative = presentationHome(this); if (alternative) return alternative;
    const h = this.h, totals = progressTotals(this.store.value), resume = this.store.value.resume;
    const hero = h('section',{class:'learn-hero'}, h('span',{class:'learn-eyebrow'},'A little practice. A deeper understanding.'), h('h1',{},'Make your next move count.'),
      this.p('Explore the ideas behind good chess, practise a tactic, or build an opening you understand.'),
      this.button(resume?'Continue learning':'Start with the fundamentals',()=>resume?this.resume(resume):this.startLesson('development'),{class:'learn-button primary'}));
    const stats = h('div',{class:'learn-stats'}, ...[[totals.unique,'Unique puzzles solved'],[totals.repeats,'Repeat completions'],[totals.assisted,'Assisted solutions'],[`${totals.lessons}/${LESSONS.length}`,'Lessons completed']].map(([n,label])=>h('div',{},h('strong',{},n),h('span',{},label))));
    const cards = h('div',{class:'learn-cards destinations'},
      this.card('01 · PRACTISE','Puzzles',`${this.puzzles.length} verified positions. Build pattern recognition, revisit mistakes, or race the clock.`,()=>this.navigate('puzzles'),'Enter the puzzle room'),
      this.card('02 · UNDERSTAND','Chess Concepts',`${LESSONS.length} complete lessons. Understand the idea, see it on the board, and put it into practice.`,()=>this.navigate('concepts'),'Explore concepts'),
      this.card('03 · PREPARE','Openings',`${OPENINGS.length} courses with plans, pawn structures and practice from either side.`,()=>this.navigate('openings'),'Build your repertoire'));
    const unfinished = h('section',{class:'learn-panel'},this.heading('Your next step'), resume ? this.p(this.resumeLabel(resume)) : this.p('New here? Develop your pieces is a good first lesson.'),
      this.button('Revisit difficult exercises',async()=>{await this.navigate('concepts');this.filters.status='Struggled';this.render();}),
      this.button('Review puzzle mistakes',()=>this.startPuzzleSelection(this.puzzles.filter(p=>this.store.value.puzzles[p.id]?.struggled))));
    return h('div',{},hero,stats,cards,unfinished);
  }
  resumeLabel(resume) {
    if (resume.kind==='lesson') return 'Continue ' + (LESSONS.find(l=>l.id===resume.id)?.title || 'your concept lesson');
    if (resume.kind==='opening') return 'Continue ' + (OPENINGS.find(o=>o.id===resume.id)?.title || 'your opening course');
    return 'Continue your unfinished puzzle';
  }
  resume(r) {if (r.kind==='lesson') this.startLesson(r.id,r); else if(r.kind==='opening') this.startOpening(r.id,r); else {const p=this.puzzles.find(p=>p.id===r.id);if(p)this.startPuzzleSelection([p],r);else this.navigate('puzzles');}}
  card(meta, title, copy, action, label = 'Open', extra = null) {
    if (this.presentation==='board') return this.h('article',{class:'learn-card studio-library-row'},this.h('div',{class:'studio-row-copy'},this.h('span',{class:'learn-eyebrow'},meta),this.h('h3',{},title),this.p(copy),extra),this.button(label+' ↗',action));
    return this.h('article',{class:'learn-card'},this.h('span',{class:'learn-eyebrow'},meta),this.h('h3',{},title),this.p(copy),extra,this.button(label,action));
  }
  search() {return this.h('input',{type:'search',placeholder:'Search the library…',value:this.filters.search,'aria-label':'Search the library','data-focus':'search',oninput:e=>{this.filters.search=e.target.value;this.render();}});}
  select(label, key, options) {
    const node = this.h('select',{'aria-label':label,'data-focus':key,onchange:e=>{this.filters[key]=e.target.value;this.render();}}, ...options.map(option=>this.h('option',{value:option},option)));
    node.value=this.filters[key];return this.h('label',{class:'learn-filter'},this.h('span',{},label),node);
  }
  matches(text) {return text.toLowerCase().includes(this.filters.search.toLowerCase());}
  empty(copy) {return this.h('div',{class:'learn-empty'},this.heading('Nothing here yet'),this.p(copy),this.button('Clear filters',()=>{for(const k of ['category','difficulty','theme','phase','status','family'])this.filters[k]='All';this.filters.search='';this.filters.bookmarks=false;this.render();}));}
  conceptsView() {
    const h = this.h, items = LESSONS.filter(l=>this.matches(l.title+' '+l.explanation+' '+l.category)
      && (this.filters.category==='All'||l.category===this.filters.category)
      && (this.filters.difficulty==='All'||DIFFICULTIES[l.level-1]===this.filters.difficulty)
      && (this.filters.status==='All'||this.filters.status==='Struggled'&&Object.values(this.store.value.lessons[l.id]?.exercises||{}).some(e=>e.struggled)||this.status('lessons',l.id)===this.filters.status));
    return h('div',{},this.heading('Chess Concepts'),this.p('Understand the idea. Observe it. Put it into practice.'),
      h('div',{class:'learn-filters'},this.search(),this.select('Category','category',['All',...CATEGORIES]),this.select('Level','difficulty',['All',...DIFFICULTIES]),this.select('Progress','status',['All','not started','in progress','completed','Struggled'])),
      ...CATEGORIES.map(category=>{const list=items.filter(l=>l.category===category);return list.length?h('section',{class:'learn-category'},h('h3',{},category),h('div',{class:'learn-cards'},...list.sort((a,b)=>a.level-b.level).map(l=>this.card(DIFFICULTIES[l.level-1]+' · '+this.status('lessons',l.id),l.title,l.why,()=>this.startLesson(l.id),'Open lesson',l.prerequisites.length?this.p('Helpful first: '+l.prerequisites.map(id=>LESSONS.find(x=>x.id===id)?.title).join(', '),'learn-small'):null)))):null;}),
      !items.length&&this.empty('Try another category or search term. Only complete lessons appear in this library.'));
  }
  async startLesson(id, resume = {}) {
    const lesson=LESSONS.find(l=>l.id===id);if(!lesson)return;
    if(!resume.tab&&this.filters.status==='Struggled') {
      const first=Object.entries(this.store.value.lessons[id]?.exercises||{}).find(([,e])=>e.struggled);
      if(first)resume={tab:'practise',exercise:+first[0]};
    }
    this.result=null;this.page='concepts';this.generation++;this.activity={kind:'lesson',id,tab:resume.tab||'understand',example:resume.example||0,ply:resume.ply||0,exercise:resume.exercise||0};
    this.scrollToTop(true);
    this.clearAnswer();
    await this.persist(p=>{const entry=p.lessons[id]||={status:'in progress',exercises:{}};if(entry.status!=='completed')entry.status='in progress';p.resume={...this.activity};});this.render();
  }
  async lessonTab(tab) {this.activity.tab=tab;this.clearAnswer();this.scrollToTop(true);await this.persist(p=>{p.resume={...this.activity};});this.render();}
  lessonExamples(lesson) {const contrast=lesson.exercises.find(e=>e.type==='choice');return [...lesson.examples,...(contrast?[{fen:contrast.fen,moves:[],captions:[contrast.explanation],highlights:[]}]:[])];}
  lessonView() {
    const a=this.activity,l=LESSONS.find(l=>l.id===a.id),h=this.h,record=this.store.value.lessons[l.id]||{exercises:{}};
    const tabs=h('div',{class:'learn-tabs'},...['understand','observe','practise'].map(t=>this.button(t[0].toUpperCase()+t.slice(1),()=>this.lessonTab(t),{'aria-pressed':a.tab===t?'true':'false',disabled:this.busy})));
    const head=h('div',{class:'learn-activity-head'},h('div',{class:'learn-topline'},this.button('← Lesson library',()=>this.navigate('concepts'),{disabled:this.busy}),h('span',{class:'learn-eyebrow'},l.category+' · '+DIFFICULTIES[l.level-1])),this.heading(l.title),h('div',{class:'learn-subline'},this.p(`${Object.values(record.exercises).filter(e=>e.passed).length}/${l.exercises.length} exercises passed · ${record.status||'in progress'}`),tabs));
    if(a.tab==='understand')return h('div',{},head,h('div',{class:'learn-study'},this.board(l.examples[0].fen,{highlights:l.examples[0].highlights}),h('article',{class:'learn-panel learn-copy'},h('h3',{},'The idea'),this.p(l.explanation),h('h3',{},'Why it matters'),this.p(l.why),h('h3',{},'Common mistakes'),h('ul',{},...l.mistakes.map(m=>h('li',{},m))),l.prerequisites.length&&h('div',{},this.p('Helpful prerequisites'),...l.prerequisites.map(id=>this.button(LESSONS.find(x=>x.id===id).title,()=>this.startLesson(id)))),this.button('See it on the board →',()=>this.lessonTab('observe'),{class:'learn-button primary'}))));
    if(a.tab==='observe') {
      const examples=this.lessonExamples(l),ex=examples[Math.min(a.example,examples.length-1)],c=new Chess(ex.fen),ply=Math.min(a.ply,ex.moves.length);
      for(const m of ex.moves.slice(0,ply))playUci(c,m);
      return h('div',{},head,h('div',{class:'learn-study'},this.board(c.fen(),{highlights:ex.highlights,last:ply?ex.moves[ply-1]:null}),h('article',{class:'learn-panel learn-copy'},h('h3',{},a.example<l.examples.length?'Watch the idea unfold':'A useful contrast'),this.p(ex.captions[ply]),this.moveNavigation(ply,ex.moves.length,async next=>{a.ply=next;await this.persist(p=>{p.resume={...a};});this.render();}),this.button('Next example',async()=>{a.example=(a.example+1)%examples.length;a.ply=0;await this.persist(p=>{p.resume={...a};});this.render();}),this.p(`Example ${a.example+1} of ${examples.length}`,'learn-small'),this.button('Put it into practice →',()=>this.lessonTab('practise'),{class:'learn-button primary'}))));
    }
    const ex=l.exercises[a.exercise],r=record.exercises[a.exercise];
    return h('div',{},head,h('div',{class:'learn-study'},this.board(this.exerciseFen||ex.fen,{interactive:!this.busy&&this.feedback?.status!=='correct'&&ex.type!=='choice',squareSelection:ex.type==='squares',highlights:this.revealedSquares||[],last:this.lastMove}),h('article',{class:'learn-panel learn-copy'},h('span',{class:'learn-eyebrow'},`Exercise ${a.exercise+1} of ${l.exercises.length} · ${ex.type==='squares'?'Select squares':ex.type==='choice'?'Read the position':'Play a move'}`),h('h3',{},ex.prompt),
      ex.type==='choice'?h('div',{class:'learn-options'},...ex.options.map((option,i)=>this.button(option,()=>this.submitExercise(i),{disabled:this.busy||this.feedback?.status==='correct'}))):ex.type==='squares'?h('div',{},this.p(ex.selection==='one'?'Choose one square.':'Select every matching square, then check your answer.'),this.button('Check selection',()=>this.submitExercise([...this.marked]),{disabled:!this.marked.size||this.busy||this.feedback?.status==='correct',class:'learn-button primary'})):this.moveInput(),
      this.feedbackView(),this.button('Show explanation',async()=>{this.feedback={status:'info',feedback:ex.explanation};this.revealedSquares=ex.type==='squares'?validSquares(ex):[];await this.persist(p=>{const e=p.lessons[l.id].exercises[a.exercise]||={};e.struggled=true;});this.render();},{disabled:this.busy||this.feedback?.status==='correct'}),
      this.button('Try again',()=>{this.clearAnswer();this.render();},{disabled:this.busy}),
      this.button(a.exercise+1<l.exercises.length?'Next exercise':'Revisit first exercise',async()=>{a.exercise=(a.exercise+1)%l.exercises.length;this.clearAnswer();await this.persist(p=>{p.resume={...a};});this.render();},{disabled:this.busy}),
      r?.struggled&&this.p('Saved for another visit. A clean correct answer clears this exercise from your difficult list.','learn-small'),
      record.status==='completed'&&h('div',{class:'learn-completion'},h('h3',{},'Lesson completed'),this.p('You have passed every exercise. Return any time to practise again.')))));
  }
  clearAnswer() {this.feedback=null;this.selected=null;this.marked.clear();this.exerciseFen=null;this.revealedSquares=null;this.lastMove=null;}
  async checkExercise(ex,answer) {
    // Bound detector work off the UI thread. Unsupported environments retain the
    // same pure validator; tests and rules-only exercises need no worker.
    if (ex.type!=='move'||!ex.objective.startsWith('event:')||typeof Worker==='undefined') return validateExercise(ex,answer);
    try {
      if(!this.worker){this.worker=new Worker(this.url('lib/learning/validation-worker.js'),{type:'module'});this.worker.onmessage=({data})=>{this.workerPending.get(data.id)?.(data.result);this.workerPending.delete(data.id);};this.worker.onerror=()=>this.stopWorker();}
      const id=++this.workerSeq;
      return await new Promise(resolve=>{const timer=setTimeout(()=>{this.workerPending.delete(id);this.stopWorker();resolve({status:'inconclusive',feedback:'Validation timed out. No incorrect answer was recorded.'});},15000);this.workerPending.set(id,r=>{clearTimeout(timer);resolve(r);});this.worker.postMessage({id,exercise:ex,answer});});
    } catch {this.stopWorker();return {status:'inconclusive',feedback:'The validator is unavailable. No incorrect answer was recorded.'};}
  }
  async submitExercise(answer) {
    if(this.busy||this.activity?.kind!=='lesson')return;
    const a=this.activity,l=LESSONS.find(l=>l.id===a.id),index=a.exercise,ex=l.exercises[index],generation=this.generation;
    this.busy=true;this.render();const r=await this.checkExercise(ex,answer);
    if(this.closed||generation!==this.generation){this.busy=false;return;}
    this.feedback=r;
    if(r.status==='correct'&&ex.type==='move'){const c=new Chess(ex.fen);playUci(c,answer);this.exerciseFen=c.fen();this.lastMove=answer;}
    if(['correct','incorrect'].includes(r.status)) await this.persist(p=>{const entry=p.lessons[l.id],e=entry.exercises[index]||={};if(r.status==='correct'){e.passed=true;e.struggled=false;}else{e.mistakes=(e.mistakes||0)+1;e.struggled=true;}entry.status=l.exercises.every((_,i)=>entry.exercises[i]?.passed)?'completed':'in progress';p.resume=entry.status==='completed'?null:{...a};});
    this.busy=false;this.render();
  }
  feedbackView() {return this.feedback?this.h('div',{class:'learn-feedback '+this.feedback.status,role:'status','aria-live':'polite'},this.feedback.feedback):this.busy?this.p('Checking your answer…','learn-feedback'):null;}
  moveNavigation(index,total,action) {return this.h('div',{class:'learn-move-nav'},this.button('⏮',()=>action(0),{'aria-label':'First position',disabled:index===0}),this.button('←',()=>action(index-1),{'aria-label':'Previous position',disabled:index===0}),this.h('span',{},`${index} / ${total}`),this.button('→',()=>action(index+1),{'aria-label':'Next position',disabled:index===total}),this.button('⏭',()=>action(total),{'aria-label':'Last position',disabled:index===total}));}
  moveInput() {
    const input=this.h('input',{type:'text',placeholder:'Move, e.g. Nf3 or e2e4','aria-label':'Enter a chess move','data-focus':'move-input',autocomplete:'off'});
    const submit=e=>{e.preventDefault();let value=input.value.trim();if(!value)return;try{const c=new Chess(this.currentFen()),m=/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value)?playUci(c,value):c.move(value);this.submitMove(m.lan);}catch{this.feedback={status:'illegal',feedback:'That move is not legal here. Use algebraic notation or select a piece and destination.'};this.render();}};
    const promotion=this.h('select',{'aria-label':'Promotion piece',onchange:e=>this.promotion=e.target.value},...['q','r','b','n'].map(piece=>this.h('option',{value:piece},'Promote to '+NAMES[piece])));promotion.value=this.promotion||'q';
    const canPromote=new Chess(this.currentFen()).moves({verbose:true}).some(m=>m.promotion);
    return this.h('div',{},this.p('Select a piece and destination, drag a piece, or type a move.','learn-small'),this.h('form',{class:'learn-move-input',onsubmit:submit},input,this.h('button',{type:'submit',class:'learn-button',disabled:this.busy||['correct','completed','revealed'].includes(this.feedback?.status)},'Play')),canPromote&&promotion);
  }
  currentFen() {
    const a=this.activity;if(a.kind==='lesson')return LESSONS.find(l=>l.id===a.id).exercises[a.exercise].fen;
    if(a.kind==='puzzle'){const p=this.puzzles.find(p=>p.id===a.id),c=new Chess(p.fen);for(const m of p.solution.slice(0,a.step))playUci(c,m);return this.puzzleFen||c.fen();}
    return this.openingState.positions[a.ply];
  }
  submitMove(value) {if(this.busy)return;if(this.activity.kind==='lesson')this.submitExercise(value);else if(this.activity.kind==='opening')this.submitOpening(value);else this.submitPuzzle(value);}
  board(fen,{interactive=false,squareSelection=false,highlights=[],last=null}={}) {
    const h=this.h,c=new Chess(fen),files=this.flipped?[...'hgfedcba']:[...'abcdefgh'],ranks=this.flipped?[1,2,3,4,5,6,7,8]:[8,7,6,5,4,3,2,1];
    const board=h('div',{class:'learn-board','aria-label':`${c.turn()==='w'?'White':'Black'} to move. Chessboard.`});
    const pick=sq=>{
      this.boardFocus=sq;
      if(!interactive)return;
      if(squareSelection){if(this.marked.has(sq))this.marked.delete(sq);else{const ex=LESSONS.find(l=>l.id===this.activity.id).exercises[this.activity.exercise];if(ex.selection==='one')this.marked.clear();this.marked.add(sq);}this.render();return;}
      const piece=c.get(sq);
      if(this.selected&&sq!==this.selected&&piece?.color!==c.turn()) {
        const promotion=(this.promotion||'q'),legal=c.moves({verbose:true}).find(m=>m.from===this.selected&&m.to===sq&&(!m.promotion||m.promotion===promotion));
        if(legal){this.selected=null;this.submitMove(legal.lan);return;}
      }
      this.selected=piece?.color===c.turn()?sq:null;this.render();
    };
    const destinations=interactive&&!squareSelection&&this.selected?c.moves({verbose:true}).filter(m=>m.from===this.selected).map(m=>m.to):[];
    ranks.forEach((rank,ri)=>files.forEach((file,ci)=>{
      const sq=file+rank,piece=c.get(sq),light=(file.charCodeAt(0)-97+8-rank)%2===0;
      const node=h('button',{type:'button',class:'learn-square '+(light?'light':'dark')+(this.selected===sq||this.marked.has(sq)?' selected':'')+(highlights?.includes(sq)?' annotated':'')+(last&&(last.slice(0,2)===sq||last.slice(2,4)===sq)?' last-move':''),
        'data-square':sq,'data-focus':'square-'+sq,tabindex:sq===(this.boardFocus||files[0]+ranks[0])?'0':'-1','aria-label':sq+(piece?`, ${piece.color==='w'?'White':'Black'} ${NAMES[piece.type]}`:', empty'),
        'aria-pressed':squareSelection?(this.marked.has(sq)?'true':'false'):null,onclick:()=>pick(sq),ondragover:e=>{if(interactive)e.preventDefault();},ondrop:e=>{e.preventDefault();const from=e.dataTransfer.getData('text/plain');if(!interactive||squareSelection)return;const m=c.moves({verbose:true}).find(m=>m.from===from&&m.to===sq&&(!m.promotion||m.promotion===(this.promotion||'q')));if(m)this.submitMove(m.lan);}});
      if(piece){const image=this.makePiece(piece.type,piece.color);image.draggable=interactive&&!squareSelection&&piece.color===c.turn();image.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',sq);});node.append(image);}
      if(ci===0)node.append(h('span',{class:'learn-coordinate rank','aria-hidden':'true'},rank));if(ri===7)node.append(h('span',{class:'learn-coordinate file','aria-hidden':'true'},file));
      if(destinations.includes(sq))node.append(h('span',{class:'learn-legal-dot','aria-hidden':'true'}));board.append(node);
    }));
    return h('div',{class:'learn-board-column'},h('div',{class:'learn-board-caption'},h('strong',{},c.turn()==='w'?'White to move':'Black to move'),this.button('Flip board',()=>{this.flipped=!this.flipped;this.render();})),board,this.busy&&this.p('Checking…','learn-small'));
  }

  puzzlesView() {
    const h=this.h,items=this.filteredPuzzles();
    return h('div',{},this.heading('Puzzles'),this.p('Practise at your pace, or see how many you can solve against the clock.'),
      h('div',{class:'learn-filters'},this.search(),this.select('Difficulty','difficulty',['All',...DIFFICULTIES]),this.select('Theme','theme',['All',...Object.values(THEME_NAMES)]),this.select('Phase','phase',['All','Opening','Middlegame','Endgame']),this.select('Progress','status',['All','Unsolved','Solved','Assisted','Mistakes'])),
      h('div',{class:'learn-panel learn-practice-actions'},this.p(`${items.length} positions match your selection.`),this.button('Practise selection',()=>this.startPuzzleSelection(items),{class:'learn-button primary',disabled:!items.length}),this.button('Mixed practice',()=>this.startPuzzleSelection(this.puzzles)),this.button('Revisit mistakes',()=>this.startPuzzleSelection(this.puzzles.filter(p=>this.store.value.puzzles[p.id]?.struggled)))),
      h('section',{class:'learn-panel'},h('h3',{},'Race the clock'),this.p('Choose a duration to see the rules before starting. Timed challenges use the whole mixed library.'),h('div',{class:'learn-inline'},...[60,300,600].map(seconds=>this.button(seconds/60+' minute'+(seconds===60?'':'s'),()=>{this.challengeSetup=seconds;this.render();}))),
        this.challengeSetup&&h('div',{class:'learn-rules'},h('h3',{},`${this.challengeSetup/60}-minute challenge`),this.p('Solve as many distinct puzzles as you can. A wrong move is recorded as a mistake and keeps the same position; there is no extra time penalty. A skip moves on and is recorded. Hints or revealing a solution make that puzzle assisted, so it does not count toward your score or personal best.'),this.p('Accuracy measures correct submitted moves ÷ all legal submitted moves. Illegal inputs do not count. The clock starts with the first ready board and pauses while loading, validating or saving; thinking time continues, including in a background tab. Returning to review ends and saves the run.'),this.button('Start challenge',()=>this.startChallenge(this.challengeSetup),{class:'learn-button primary'}))),
      items.length?h('div',{class:'learn-cards puzzle-library'},...items.slice(0,this.puzzleLimit||24).map(p=>this.card(`${p.difficulty} · ${p.phase}`,`${THEME_NAMES[p.theme]} · ${p.rating}`,this.store.value.puzzles[p.id]?.clean?'Solved without assistance':this.store.value.puzzles[p.id]?.assisted?'Previously completed with assistance':'Unsolved',()=>this.startPuzzleSelection([p]),'Practise'))):this.empty('Try another filter, or solve a few puzzles to build your mistake list.'),
      items.length>(this.puzzleLimit||24)&&this.button('Show more puzzles',()=>{this.puzzleLimit=(this.puzzleLimit||24)+24;this.render();}));
  }
  filteredPuzzles() {return this.puzzles.filter(p=>{
    const r=this.store.value.puzzles[p.id];return this.matches(`${THEME_NAMES[p.theme]} ${p.id} ${p.rating} ${p.themes.join(' ')}`)
      &&(this.filters.difficulty==='All'||p.difficulty===this.filters.difficulty)
      &&(this.filters.theme==='All'||p.themes.some(t=>THEME_NAMES[t]===this.filters.theme))
      &&(this.filters.phase==='All'||p.phase===this.filters.phase)
      &&(this.filters.status==='All'||this.filters.status==='Unsolved'&&!r?.clean||this.filters.status==='Solved'&&r?.clean>0||this.filters.status==='Assisted'&&r?.assisted>0||this.filters.status==='Mistakes'&&r?.struggled);
  });}
  shuffle(items) {const list=[...items];for(let i=list.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[list[i],list[j]]=[list[j],list[i]];}return list;}
  async startPuzzleSelection(items,resume=null) {
    if(!items.length){this.feedback=null;this.activity=null;this.page='puzzles';this.filters.status='Mistakes';this.render();return;}
    this.result=null;this.page='puzzles';this.queue=this.shuffle(items);this.queueIndex=0;this.generation++;this.scrollToTop(true);await this.preparePuzzle(this.queue[0],resume);
  }
  async preparePuzzle(puzzle,resume=null) {
    this.clearAnswer();this.hintSquare=null;this.puzzleFen=null;this.solutionPly=0;this.attemptRecorded=false;
    const step=Number.isInteger(resume?.step)&&resume.step>=0&&resume.step<puzzle.solution.length&&resume.step%2===0?resume.step:0;
    this.activity={kind:'puzzle',id:puzzle.id,step,assisted:!!resume?.assisted,mistakes:resume?.mistakes||0};
    this.flipped=puzzle.fen.split(' ')[1]==='b';
    if(!this.run)await this.persist(p=>{p.resume={...this.activity};});
    this.render();if(this.run){this.run.clock.ready();this.updateClock();}
  }
  puzzleView() {
    const h=this.h,a=this.activity,p=this.puzzles.find(p=>p.id===a.id),done=['completed','revealed'].includes(this.feedback?.status),c=new Chess(p.fen);
    for(const m of p.solution.slice(0,a.step))playUci(c,m);
    const fen=done&&this.feedback.status==='revealed'?this.solutionFen(p,this.solutionPly):this.puzzleFen||c.fen();
    const explanation=done?puzzleExplanation(p):[];
    return h('div',{},h('div',{class:'learn-activity-head'},!this.run&&this.button('← Puzzle library',()=>this.navigate('puzzles'),{disabled:this.busy}),this.heading(this.run?'Timed challenge':'Your next challenge'),this.run&&h('div',{class:'learn-timer',role:'timer','aria-label':'Time remaining'},h('strong',{id:'learn-clock'}),h('span',{},`${this.run.solved} solved · ${this.run.mistakes} mistakes`),this.button('Finish challenge',()=>this.finishChallenge('Ended early'),{disabled:this.busy}))),
      h('div',{class:'learn-study'},this.board(fen,{interactive:!done&&!this.busy,highlights:this.hintSquare?[this.hintSquare]:[],last:this.lastMove}),h('article',{class:'learn-panel learn-copy'},h('span',{class:'learn-eyebrow'},`${p.difficulty} · ${p.phase} · ${this.queueIndex+1}/${this.queue.length}${a.assisted?' · Assisted attempt':''}`),h('h3',{},p.themes.includes('mateIn1')?'Deliver mate in one.':p.themes.includes('mateIn2')?'Find mate in two.':'Find the strongest continuation.'),this.p('Look for checks, captures and threats.'),!done&&this.moveInput(),this.feedbackView(),
        !done&&h('div',{class:'learn-inline'},this.button('Hint',()=>this.hintPuzzle(),{disabled:this.busy}),this.button('Reveal solution',()=>this.revealPuzzle(),{disabled:this.busy}),this.button('Skip',()=>this.skipPuzzle(),{disabled:this.busy})),
        done&&h('div',{},h('h3',{},'Why the solution works'),h('ol',{},...explanation.map(note=>h('li',{},note))),this.p(`Theme: ${THEME_NAMES[p.theme]}. The moves above show how the idea appears in this exact position.`),this.feedback.status==='revealed'&&this.moveNavigation(this.solutionPly,p.solution.length,next=>{this.solutionPly=next;this.lastMove=next?p.solution[next-1]:null;this.render();this.updateClock();}),
          this.button('Explore the concept',()=>this.startLesson(themeLesson[p.theme]),{disabled:!!this.run}),h('a',{href:p.source.url,target:'_blank',rel:'noopener noreferrer'},'Source puzzle on Lichess'),
          this.button('Next puzzle →',()=>this.nextPuzzle(),{class:'learn-button primary',disabled:this.busy}),!this.run&&this.button('Retry this puzzle',()=>this.preparePuzzle(p))))));
  }
  solutionFen(p,ply) {const c=new Chess(p.fen);for(const m of p.solution.slice(0,ply))playUci(c,m);return c.fen();}
  async submitPuzzle(value) {
    if(this.busy||this.attemptRecorded||this.run?.clock.expired()){if(this.run?.clock.expired())await this.finishChallenge('Time is up');return;}
    const a=this.activity,p=this.puzzles.find(p=>p.id===a.id);this.busy=true;this.run?.clock.pause();
    const answer=validatePuzzleMove(p,a.step,value);
    this.selected=null;
    if(answer.status==='correct') {
      if(this.run)this.run.correctMoves++;this.lastMove=value;this.puzzleFen=answer.fen;a.step++;
      if(!answer.terminal&&a.step<p.solution.length){const c=new Chess(this.puzzleFen);playUci(c,p.solution[a.step]);this.lastMove=p.solution[a.step];this.puzzleFen=c.fen();a.step++;}
      if(answer.terminal||a.step>=p.solution.length) {
        this.feedback={status:'completed',feedback:a.assisted?'Completed with assistance. Review the idea and try it unaided next time.':'Solved. You found the complete continuation.'};
        await this.recordAttempt(true,false);
      } else {this.feedback={status:'info',feedback:'Good move. Your opponent has replied; continue the line.'};if(!this.run)await this.persist(p=>{p.resume={...a};});}
    } else {
      this.feedback=answer;if(answer.status==='incorrect'){a.mistakes++;if(this.run)this.run.mistakes++;await this.persist(p=>{const r=p.puzzles[a.id]||={clean:0,assisted:0,mistakes:0,attempts:0,struggled:false};r.struggled=true;if(!this.run)p.resume={...a};});}
    }
    this.busy=false;this.render();this.run?.clock.ready();this.updateClock();
  }
  async recordAttempt(completed,skipped) {
    if(this.attemptRecorded)return;this.attemptRecorded=true;
    const a={...this.activity};
    if(this.run){if(completed){if(a.assisted)this.run.assisted++;else this.run.solved++;}if(skipped)this.run.skips++;if(a.mistakes||a.assisted||skipped)this.run.missed.push(a.id);}
    await this.persist(p=>{recordPuzzle(p,a.id,{completed,skipped,assisted:a.assisted,mistakes:a.mistakes});if(p.resume?.id===a.id)p.resume=null;});
  }
  async hintPuzzle() {
    if(this.busy||this.run?.clock.expired()){if(this.run?.clock.expired())await this.finishChallenge('Time is up');return;}
    const a=this.activity,p=this.puzzles.find(p=>p.id===a.id),value=p.solution[a.step];a.assisted=true;this.hintSquare=value.slice(0,2);
    this.feedback={status:'info',feedback:`Consider the ${NAMES[new Chess(this.currentFen()).get(this.hintSquare).type]} on ${this.hintSquare}. This attempt now counts as assisted.`};
    this.run?.clock.pause();if(!this.run)await this.persist(p=>{p.resume={...a};});this.render();this.run?.clock.ready();this.updateClock();
  }
  async revealPuzzle() {
    if(this.busy||this.attemptRecorded)return;this.busy=true;this.run?.clock.pause();this.activity.assisted=true;this.hintSquare=null;this.solutionPly=0;
    await this.recordAttempt(true,false);this.feedback={status:'revealed',feedback:'Solution revealed. This is saved as an assisted solution.'};this.busy=false;this.render();this.run?.clock.ready();this.updateClock();
  }
  async skipPuzzle() {if(this.busy)return;this.busy=true;this.run?.clock.pause();await this.recordAttempt(false,true);this.busy=false;await this.nextPuzzle();}
  async nextPuzzle() {
    if(this.busy)return;this.run?.clock.pause();this.hintSquare=null;
    if(++this.queueIndex>=this.queue.length){if(this.run)await this.finishChallenge('All puzzles in this run are complete');else{this.activity=null;this.feedback=null;this.page='puzzles';this.render();}return;}
    await this.preparePuzzle(this.queue[this.queueIndex]);
  }
  async startChallenge(duration) {
    this.challengeSetup=null;this.result=null;this.run={duration,clock:new ChallengeClock(duration),solved:0,assisted:0,mistakes:0,skips:0,correctMoves:0,missed:[]};
    await this.startPuzzleSelection(this.puzzles);
    clearInterval(this.ticker);this.ticker=setInterval(()=>{if(this.run?.clock.expired()&&!this.busy)this.finishChallenge('Time is up');else this.updateClock();},200);
  }
  updateClock() {const node=this.root?.querySelector('#learn-clock');if(node&&this.run){const seconds=Math.ceil(this.run.clock.remaining()/1000);node.textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}}
  async finishChallenge(reason,show=true) {
    if(!this.run||this.finishing)return;this.finishing=true;this.run.clock.pause();clearInterval(this.ticker);
    // Record an unfinished puzzle that accumulated mistakes; an untouched board
    // at timeout is not silently counted as a skip or as an attempted puzzle.
    if(!this.attemptRecorded&&(this.activity?.mistakes||this.activity?.assisted))await this.recordAttempt(false,false);
    const run=this.run;this.run=null;
    let result=challengeResult(run,this.store.value.bests[run.duration]||0);
    await this.persist(p=>{result=challengeResult(run,p.bests[run.duration]||0);p.bests[run.duration]=result.best;p.challenges.push(result);p.challenges=p.challenges.slice(-100);});
    this.result={...result,reason};this.activity=null;this.busy=false;this.finishing=false;if(show&&!this.closed){this.scrollToTop();this.render();}
  }
  resultView() {
    const h=this.h,r=this.result;
    return h('section',{class:'learn-results'},h('span',{class:'learn-eyebrow'},`${r.duration/60}-minute challenge · ${r.reason}`),h('h1',{},r.personalBest?'A new personal best.':'Good practice, well played.'),
      h('div',{class:'learn-stats'},...[[r.solved,'Puzzles solved'],[r.mistakes,'Mistakes'],[r.accuracy+'%','Move accuracy'],[r.best,'Personal best'],[r.assisted,'Assisted solutions'],[r.skips,'Skipped']].map(([n,label])=>h('div',{},h('strong',{},n),h('span',{},label)))),
      this.p('Only unassisted completions count toward your timed score. Each puzzle appeared once in this run.'),
      this.button('Review missed puzzles',()=>{const missed=this.puzzles.filter(p=>r.missed.includes(p.id));this.result=null;this.startPuzzleSelection(missed);},{disabled:!r.missed.length,class:'learn-button primary'}),
      this.button('Try another challenge',()=>{this.result=null;this.navigate('puzzles');}),this.button('Learning home',()=>{this.result=null;this.navigate('home');}));
  }

  openingsView() {
    const h=this.h,items=OPENINGS.filter(o=>this.matches(o.title+' '+o.family+' '+o.plans)&& (this.filters.family==='All'||this.filters.family===o.family)&& (this.filters.difficulty==='All'||DIFFICULTIES[o.level-1]===this.filters.difficulty)&&(!this.filters.bookmarks||this.store.value.openings[o.id]?.bookmarked));
    return h('div',{},this.heading('Openings'),this.p('Learn where the pieces belong, why the moves make sense, and what the pawn structure asks of you.'),
      h('div',{class:'learn-filters'},this.search(),this.select('Family','family',['All',...new Set(OPENINGS.map(o=>o.family))]),this.select('Level','difficulty',['All',...DIFFICULTIES]),this.select('Playing color','color',['Both','White','Black']),this.button(this.filters.bookmarks?'Show all':'Bookmarks',()=>{this.filters.bookmarks=!this.filters.bookmarks;this.render();},{'aria-pressed':String(this.filters.bookmarks)})),
      items.length?h('div',{class:'learn-cards'},...items.map(o=>this.card(o.family+' · '+this.status('openings',o.id),o.title,o.plans,()=>this.startOpening(o.id,{color:this.filters.color==='Black'?'b':'w'}),'Study opening',this.button(this.store.value.openings[o.id]?.bookmarked?'★ Bookmarked':'☆ Bookmark',async()=>{await this.persist(p=>{const r=p.openings[o.id]||={status:'not started',completed:{}};r.bookmarked=!r.bookmarked;});this.render();})))):this.empty('Try another opening family or add a bookmark.'));
  }
  async startOpening(id,resume={}) {
    const o=OPENINGS.find(o=>o.id===id);if(!o)return;this.result=null;this.page='openings';this.generation++;this.scrollToTop(true);
    this.activity={kind:'opening',id,line:Math.min(resume.line||0,o.lines.length-1),ply:resume.ply||0,color:resume.color||'w',practice:!!resume.practice};this.openingAssisted=!!resume.assisted;this.clearAnswer();this.setOpeningState();
    if(this.activity.practice)this.autoReply();
    await this.persist(p=>{const r=p.openings[id]||={status:'in progress',completed:{}};if(r.status!=='completed')r.status='in progress';p.resume={...this.activity};});this.render();
  }
  setOpeningState() {const a=this.activity,o=OPENINGS.find(o=>o.id===a.id);this.openingState=linePositions(o.lines[a.line]);a.ply=Math.max(0,Math.min(a.ply,this.openingState.moves.length));this.flipped=a.color==='b';}
  autoReply() {const a=this.activity;if(a.ply<this.openingState.moves.length&&new Chess(this.openingState.positions[a.ply]).turn()!==a.color)a.ply++;}
  openingView() {
    const h=this.h,a=this.activity,o=OPENINGS.find(o=>o.id===a.id),line=o.lines[a.line],max=this.openingState.moves.length,complete=a.practice&&a.ply>=max;
    const lineSelect=h('select',{'aria-label':'Opening variation',disabled:this.busy,onchange:e=>{a.line=+e.target.value;a.ply=0;this.openingAssisted=false;a.assisted=false;this.clearAnswer();this.setOpeningState();if(a.practice)this.autoReply();this.persist(p=>{p.resume={...a};}).then(()=>this.render());}},...o.lines.map((l,i)=>h('option',{value:i},l.name)));lineSelect.value=a.line;
    const colorSelect=h('select',{'aria-label':'Practice color',disabled:this.busy,onchange:e=>{a.color=e.target.value;a.ply=0;this.openingAssisted=false;a.assisted=false;this.clearAnswer();this.setOpeningState();if(a.practice)this.autoReply();this.persist(p=>{p.resume={...a};}).then(()=>this.render());}},h('option',{value:'w'},'White'),h('option',{value:'b'},'Black'));colorSelect.value=a.color;
    const book=this.book()?.[positionKey(this.openingState.positions[a.ply])];
    return h('div',{},h('div',{class:'learn-activity-head'},this.button('← Opening library',()=>this.navigate('openings'),{disabled:this.busy}),h('span',{class:'learn-eyebrow'},o.family),this.heading(o.title),h('div',{class:'learn-inline'},lineSelect,colorSelect,this.button(a.practice?'Study the line':'Practise this line',async()=>{a.practice=!a.practice;a.ply=0;this.openingAssisted=false;a.assisted=false;this.clearAnswer();if(a.practice)this.autoReply();await this.persist(p=>{p.resume={...a};});this.render();},{class:'learn-button primary',disabled:this.busy}))),
      h('div',{class:'learn-study'},this.board(this.openingState.positions[a.ply],{interactive:a.practice&&!complete&&!this.busy,last:this.lastMove}),h('article',{class:'learn-panel learn-copy'},
        a.practice?h('div',{},h('h3',{},complete?'Line completed':`Your turn as ${a.color==='w'?'White':'Black'}`),!complete&&this.moveInput(),this.feedbackView(),!complete&&this.button('Show the idea',async()=>{this.openingAssisted=true;a.assisted=true;this.feedback={status:'info',feedback:line.notes[a.ply]};await this.persist(p=>{p.resume={...a};});this.render();},{disabled:this.busy}),complete&&this.button('Practise again',async()=>{a.ply=0;this.openingAssisted=false;a.assisted=false;this.feedback=null;this.autoReply();await this.persist(p=>{p.resume={...a};});this.render();})):
          h('div',{},h('h3',{},a.ply?line.moves[a.ply-1]:'The starting position'),this.p(a.ply?line.notes[a.ply-1]:'Choose a variation and step through the moves. Watch how development and central choices work together.'),this.moveNavigation(a.ply,max,async next=>{a.ply=next;this.lastMove=next?this.openingState.moves[next-1]:null;await this.persist(p=>{p.resume={...a};});this.render();}),h('div',{class:'learn-line'},...line.moves.map((san,i)=>this.button(san,async()=>{a.ply=i+1;this.lastMove=this.openingState.moves[i];await this.persist(p=>{p.resume={...a};});this.render();},{'aria-current':a.ply===i+1?'step':null})))),
        h('h3',{},'Plans for both sides'),this.p(o.plans),h('h3',{},'The pawn structure'),this.p(o.structure),h('h3',{},'A common mistake'),this.p(o.mistakes),h('h3',{},'A thematic tactic'),this.p(o.tactic),Array.isArray(book)&&this.p(`Offline book: ${book[0]} · ${book[1]}`,'learn-small'),this.p('Moves outside the selected line are a repertoire choice. They are not labeled bad without a separate evaluation. Transpositions to a later position in this course are recognized.','learn-small'))));
  }
  async submitOpening(value) {
    if(this.busy)return;const a=this.activity,o=OPENINGS.find(o=>o.id===a.id),line=o.lines[a.line],state=this.openingState,c=new Chess(state.positions[a.ply]);let m;
    try{m=playUci(c,value);}catch{this.feedback={status:'illegal',feedback:'That move is illegal in the current position.'};this.render();return;}
    this.selected=null;
    let next=m.lan===state.moves[a.ply]?a.ply+1:state.positions.findIndex((fen,i)=>i>a.ply&&positionKey(fen)===positionKey(c.fen()));
    if(next<0) {
      const alternate=o.lines.map(linePositions).map((other,index)=>({other,index,ply:other.positions.findIndex(fen=>positionKey(fen)===positionKey(c.fen()))})).find(item=>item.ply>=0);
      if(alternate){a.line=alternate.index;this.openingState=alternate.other;next=alternate.ply;}
    }
    if(next<0){this.feedback={status:'info',feedback:`${m.san} is legal, but outside this selected line. That does not mean it is a bad move. Try the course continuation or study another variation.`};this.render();return;}
    this.busy=true;const note=line.notes[a.ply];a.ply=next;this.lastMove=value;this.autoReply();const completed=a.ply>=this.openingState.moves.length;
    this.feedback={status:completed?'completed':'info',feedback:completed?'You completed the line from your chosen side. Keep the plans in mind when the game takes a different route.':`Good: ${note} The opponent has replied.`};
    await this.persist(p=>{const r=p.openings[o.id];if(completed){r.completed[a.line+':'+a.color]={assisted:!!this.openingAssisted,at:Date.now()};r.status=o.lines.every((_,i)=>['w','b'].every(color=>r.completed[i+':'+color]))?'completed':'in progress';}p.resume=completed?null:{...a};});this.busy=false;this.render();
  }
}
