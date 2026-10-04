const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  .split('/* ============ boot ============ */')[0];

function app() {
  const elements = {};
  const context = vm.createContext({
    console, window: { scrollTo() {} }, navigator: {},
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout() { return 1; }, clearTimeout() {},
    confirm() { throw new Error('Updating a review must not ask to replace it'); },
    document: {
      getElementById(id) {
        return elements[id] || (elements[id] = { value: '', hidden: true, addEventListener() {} });
      },
      querySelectorAll() { return []; }
    }
  });
  vm.runInContext(script, context);
  vm.runInContext(`
    render=()=>{};closeSheet=()=>{};toast=()=>{};
    openSheet=html=>{
      document.getElementById('sheetBody').innerHTML=html;
      const m=html.match(/<textarea id="rv-text"[^>]*>([\\s\\S]*?)<\\/textarea>/);
      if(m)document.getElementById('rv-text').value=m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&');
    };
    state=freshState();
    function addCard(id,date,status='Done') {
      state.cards.push({id,title:'Activity '+id,type:'Science',status,date,details:'Plan '+id,materials:'Supplies '+id,happened:'What happened '+id,childNotes:'Child note '+id,archived:false});
    }
    function saveReview(){document.getElementById('rv-text').value+='\\nPersonal reflection';rwSave();}
  `, context);
  return code => vm.runInContext(code, context);
}

test('overdue cards stay visible in Today, Archive and their own day', () => {
  const run = app();
  run("addCard('old','2020-01-02')");
  assert.equal(run("pendingDays().includes('2020-01-02')"), true);
  assert.match(run('renderToday()'), /Days awaiting review · 1/);
  assert.match(run('renderArchive()'), /2020-01-02/);
  run("openDay('2020-01-02')");
  assert.match(run('renderToday()'), /Activity old/);
  run('startReview();saveReview()');
  assert.equal(run('state.records[0].date'), '2020-01-02');
  assert.equal(run('state.records[0].cards[0].materials'), 'Supplies old');
  assert.equal(run('pendingDays().length'), 0);
  run("openDay('2020-01-02')");
  assert.match(run('renderToday()'), /Activity old/);
  assert.match(run('renderToday()'), /Personal reflection/);
});

test('reopening a saved review preserves text, card snapshots and record identity', () => {
  const run = app();
  run("addCard('one',todayISO());startReview();saveReview();const recordId=state.records[0].id;const firstText=state.records[0].review;startReview()");
  assert.equal(run("document.getElementById('rv-text').value===firstText"), true);
  run('rwSave()');
  assert.equal(run('state.records.length'), 1);
  assert.equal(run('state.records[0].id===recordId'), true);
  assert.equal(run('state.records[0].review===firstText'), true);
  assert.equal(run('state.records[0].cards.length'), 1);
});

test('adding an event later appends it without losing the first review', () => {
  const run = app();
  run("addCard('one',todayISO());startReview();saveReview();addCard('two',todayISO());startReview()");
  assert.match(run("document.getElementById('rv-text').value"), /Personal reflection/);
  assert.match(run("document.getElementById('rv-text').value"), /Activity two/);
  run('rwSave();startReview();rwSave()');
  assert.equal(run('state.records[0].cards.length'), 2);
  assert.equal(run("state.records[0].review.split('Activity two').length"), 3);
});

test('editing a completed card replaces its snapshot rather than duplicating it', () => {
  const run = app();
  run("addCard('one',todayISO());startReview();saveReview();reopenCard(byId('one'));byId('one').happened='Updated observation';startReview();rwSave()");
  assert.equal(run('state.records[0].cards.length'), 1);
  assert.equal(run('state.records[0].cards[0].happened'), 'Updated observation');
});

test('legacy reviews without snapshot IDs retain their text and can be updated', () => {
  const run = app();
  run("addCard('one',todayISO());startReview();saveReview();delete state.records[0].cards[0].id;startReview()");
  assert.match(run("document.getElementById('rv-text').value"), /Personal reflection/);
  run("rwSave();reopenCard(byId('one'));byId('one').title='Renamed';startReview();rwSave()");
  assert.equal(run('state.records[0].cards.length'), 1);
  assert.equal(run('state.records[0].cards[0].title'), 'Renamed');
});

test('a retrospective happened note belongs to the selected day', () => {
  const run = app();
  run("openDay('2020-01-02');document.getElementById('h-note').value='Italian song';document.getElementById('h-title').value='Song';document.getElementById('h-type').value='Час итальянского';saveHappened()");
  assert.equal(run('state.cards[0].date'), '2020-01-02');
  assert.equal(run('state.cards[0].type'), 'Час итальянского');
  assert.equal(run("TYPES.includes('Час итальянского')"), true);
  assert.equal(run("typeof TYPE_DOT['Час итальянского']"), 'string');
});

test('overdue unfinished cards can move to today while retaining the old day record', () => {
  const run = app();
  run("addCard('old','2020-01-02','Planned');openDay('2020-01-02');startReview()");
  assert.match(run("document.getElementById('sheetBody').innerHTML"), /Move to today/);
  run("rwChoose('day:'+todayISO());rwSave()");
  assert.equal(run('state.records[0].date'), '2020-01-02');
  assert.equal(run('state.records[0].cards[0].status'), 'Moved');
  assert.equal(run('state.cards[0].date===todayISO()'), true);
  assert.equal(run('state.cards[0].archived'), false);
});

test('canceling a retrospective review leaves cards and old records untouched', () => {
  const run = app();
  run("addCard('old','2020-01-02','Planned');openDay('2020-01-02');startReview();rwChoose('basket');closeSheet()");
  assert.equal(run('state.cards[0].date'), '2020-01-02');
  assert.equal(run('state.cards[0].status'), 'Planned');
  assert.equal(run('state.records.length'), 0);
});

test('filling defaults does not duplicate already reviewed cards', () => {
  const run = app();
  run("const df=state.defaults[0];addCard('done',todayISO());state.cards[0].title=df.title;state.cards[0].archived=true;df.days=[(fromISO(todayISO()).getDay()+6)%7];state.defaults=[df];fillWeek()");
  assert.equal(run('state.cards.length'), 1);
});

test('week day headings open the day and archived cards remain reachable', () => {
  const run = app();
  run("addCard('done',todayISO());state.cards[0].archived=true");
  assert.match(run('renderWeek()'), /openDay\('/);
  assert.match(run('renderWeek()'), /Activity done/);
});

test('old diaries gain new empty shelves without losing existing cards and reviews', () => {
  const run = app();
  run("const old={cards:[{id:'kept'}],records:[{review:'My words'}],library:[{title:'Recipe'}]};state=normalizeState(old)");
  assert.equal(run("state.cards[0].id"), 'kept');
  assert.equal(run("state.records[0].review"), 'My words');
  assert.equal(run("state.library[0].title"), 'Recipe');
  assert.equal(run("state.books.length"), 0);
  assert.equal(run("state.childEntries.length"), 0);
  assert.equal(run("state.children.length"), 3);
});

test('book histories include archived reading cards and exclude plans and skipped cards', () => {
  const run = app();
  run("state.books.push({id:'book',title:'Family book',status:'reading'});['Done','Partial','Planned','Skipped'].forEach((s,i)=>{addCard('reading'+i,'2026-01-0'+(i+1),s);Object.assign(state.cards[i],{type:'Reading',bookId:'book',archived:true});})");
  assert.equal(run("bookReadings('book').length"), 2);
  assert.equal(run("bookReadings('book')[0].status"), 'Partial');
  assert.equal(run("byId('reading0').date"), '2026-01-01');
  assert.match(run("selectedBook='book';renderBook()"), /Наши чтения · 2/);
});

test('the latest reading position follows activity dates and remains optional', () => {
  const run = app();
  run("['2026-03-15','2026-02-01','2026-03-16'].forEach((date,i)=>{addCard('r'+i,date);Object.assign(state.cards[i],{type:'Reading',bookId:'b',readingPosition:i===0?'Chapter 8':i===1?'Chapter 2':''});})");
  assert.equal(run("latestPosition('b').readingPosition"), 'Chapter 8');
  assert.equal(run("latestPosition('unknown')"), null);
  assert.equal(run("bookReadings('b').length"), 3);
});

test('completed reading cards stay linked to their book after day review', () => {
  const run = app();
  run("addCard('reading',todayISO());Object.assign(byId('reading'),{type:'Reading',bookId:'book',readingPosition:'Chapter 4'});startReview();rwSave()");
  assert.equal(run("bookReadings('book').length"), 1);
  assert.equal(run("byId('reading').archived"), true);
  assert.equal(run("state.records[0].cards[0].bookId"), 'book');
  assert.equal(run("state.records[0].cards[0].readingPosition"), 'Chapter 4');
});

test('updating a card updates its notebook entries without making duplicates', () => {
  const run = app();
  run("addCard('activity',todayISO());Object.assign(byId('activity'),{bookId:'book'});editorEntries=[{id:'entry',childId:state.children[0].id,kind:'Вопрос',text:' Why? ',image:''}];saveEditorEntries(byId('activity'));saveEditorEntries(byId('activity'))");
  assert.equal(run("state.childEntries.length"), 1);
  assert.equal(run("state.childEntries[0].id"), 'entry');
  assert.equal(run("state.childEntries[0].text"), 'Why?');
  assert.equal(run("state.childEntries[0].bookId"), 'book');
  assert.equal(run("state.childEntries[0].date===todayISO()"), true);
  assert.equal(run("state.cards.length"), 1);
});

test('notebook observations survive deleting their source card', () => {
  const run = app();
  run("confirm=()=>true;addCard('source',todayISO());state.childEntries.push({id:'note',childId:state.children[0].id,cardId:'source',bookId:'book',date:todayISO(),kind:'Высказывание',text:'Keep this'});delCard('source')");
  assert.equal(run("state.cards.length"), 0);
  assert.equal(run("state.childEntries.length"), 1);
  assert.equal(run("state.childEntries[0].text"), 'Keep this');
  assert.equal(run("state.childEntries[0].cardId"), null);
  assert.equal(run("state.childEntries[0].bookId"), 'book');
});

test('removing a notebook entry from a card preserves it as a standalone observation', () => {
  const run=app();
  run("addCard('source',todayISO());state.childEntries.push({id:'note',childId:state.children[0].id,cardId:'source',date:todayISO(),kind:'Вопрос',text:'Keep me',bookId:'book'});editorEntries=[];saveEditorEntries(byId('source'))");
  assert.equal(run("state.childEntries.length"),1);
  assert.equal(run("state.childEntries[0].cardId"),null);
  assert.equal(run("state.childEntries[0].bookId"),'book');
  assert.equal(run("state.childEntries[0].text"),'Keep me');
});

test('unassigned older reading cards remain available to connect to a book', () => {
  const run = app();
  run("addCard('old',todayISO());Object.assign(byId('old'),{type:'Reading',archived:true})");
  assert.match(run("renderBooks()"), /Чтения без книги · 1/);
  assert.match(run("renderBooks()"), /openCard\('old'\)/);
});

test('backups retain books, children, linked notes and photos in the same state', () => {
  const run = app();
  run("state.books.push({id:'b',title:'Book',status:'paused'});state.childEntries.push({id:'n',childId:state.children[1].id,bookId:'b',cardId:'c',text:'A drawing',image:'data:image/jpeg;base64,YWJj'});const restored=normalizeState(JSON.parse(JSON.stringify(state)))");
  assert.equal(run("restored.books[0].status"), 'paused');
  assert.equal(run("restored.childEntries[0].image"), 'data:image/jpeg;base64,YWJj');
  assert.equal(run("restored.childEntries[0].childId===restored.children[1].id"), true);
  assert.equal(run("safeImage('javascript:alert(1)')"), '');
});

test('storage quota failures are visible and leave exportable data in memory', async () => {
  const run = app();
  run("console.error=()=>{};localStorage.setItem=()=>{throw new Error('quota')};state.books.push({title:'Keep in backup'})");
  assert.equal(await run('Store.save(state)'), false);
  assert.equal(run("document.getElementById('storageWarning').hidden"), false);
  assert.equal(run("state.books[0].title"), 'Keep in backup');
});

test('existing diaries gain an empty garden while preserving all family data', () => {
  const run=app();
  run("const old={cards:[{id:'c'}],records:[{id:'r'}],books:[{id:'b',status:'reading'}],children:[{id:'child'}],childEntries:[{id:'n'}]};state=normalizeState(old)");
  assert.equal(run('state.gardenFolders.length'),0);
  assert.equal(run('state.gardenEntries.length'),0);
  assert.equal(run("state.children[0].id"),'child');
  assert.equal(run("state.books[0].id"),'b');
  assert.equal(run("state.childEntries[0].id"),'n');
});

test('garden history joins completed daily cards and notes by date without copying cards', () => {
  const run=app();
  run("state.gardenFolders.push({id:'f',section:'projects',title:'Italian',status:'active',photos:[]});['Done','Partial','Planned','Skipped'].forEach((status,i)=>{addCard('m'+i,'2026-03-0'+(i+1),status);Object.assign(state.cards[i],{type:'Mother culture',gardenId:'f',archived:true});});state.gardenEntries.push({id:'n',folderId:'f',date:'2026-03-05',text:'Thought',photos:[]});");
  assert.equal(run("gardenHistory('f').length"),3);
  assert.equal(run("gardenHistory('f')[0].data.id"),'n');
  assert.equal(run("gardenHistory('f')[2].data.id"),'m0');
  run("selectedGardenFolder='f';renderGardenFolder();renderGardenFolder()");
  assert.equal(run('state.cards.length'),4);
  assert.equal(run('state.gardenEntries.length'),1);
});

test('day reviews preserve the garden connection and completed activities remain in their folder', () => {
  const run=app();
  run("addCard('m',todayISO());Object.assign(byId('m'),{type:'Mother culture',gardenId:'f'});startReview();rwSave()");
  assert.equal(run('state.records[0].cards[0].gardenId'),'f');
  assert.equal(run("gardenHistory('f').length"),1);
  assert.equal(run("byId('m').archived"),true);
});

test('turning an idea into a project retains its identity, history, materials and photos', () => {
  const run=app();
  run("state.gardenFolders.push({id:'f',title:'Song',section:'later',status:'idea',photos:[{src:'data:image/jpeg;base64,YWJj',caption:'Pattern'}],materials:'Words'});state.gardenEntries.push({id:'n',folderId:'f',date:todayISO(),text:'Keep me',photos:[]});gardenPhotoDrafts.folder=state.gardenFolders[0].photos.map(p=>Object.assign({},p));['title','section','status','medium','creator','intent','resume','materials'].forEach(k=>document.getElementById('gf-'+k).value=({title:'Song',section:'projects',status:'active',medium:'book',materials:'Words'})[k]||'');document.getElementById('gp-folder-caption-0').value='Pattern';saveGardenFolder('f')");
  assert.equal(run('state.gardenFolders.length'),1);
  assert.equal(run('state.gardenFolders[0].id'),'f');
  assert.equal(run('state.gardenFolders[0].section'),'projects');
  assert.equal(run('state.gardenFolders[0].photos[0].caption'),'Pattern');
  assert.equal(run('state.gardenFolders[0].materials'),'Words');
  assert.equal(run("gardenHistory('f')[0].data.text"),'Keep me');
});

test('deleting a linked daily card retains its writing and photos as a garden note', () => {
  const run=app();
  run("confirm=()=>true;state.gardenFolders.push({id:'f',section:'projects'});addCard('m',todayISO());Object.assign(byId('m'),{type:'Mother culture',gardenId:'f',gardenPhotos:[{src:'data:image/jpeg;base64,YWJj',caption:'My work'}]});delCard('m')");
  assert.equal(run('state.cards.length'),0);
  assert.equal(run('state.gardenEntries.length'),1);
  assert.equal(run('state.gardenEntries[0].text'),'What happened m');
  assert.equal(run('state.gardenEntries[0].photos[0].caption'),'My work');
  assert.equal(run("gardenHistory('f').length"),1);
});

test('deleting a garden folder preserves its daily cards and child notes', () => {
  const run=app();
  run("confirm=()=>true;state.gardenFolders.push({id:'f',section:'projects'});state.gardenEntries.push({id:'n',folderId:'f'});addCard('m',todayISO());Object.assign(byId('m'),{gardenId:'f',gardenPhotos:[{src:'data:image/jpeg;base64,YWJj'}]});state.childEntries.push({id:'child-note',cardId:'m'});deleteGardenFolder('f')");
  assert.equal(run('state.gardenFolders.length'),0);
  assert.equal(run('state.gardenEntries.length'),0);
  assert.equal(run('state.cards.length'),1);
  assert.equal(run('state.cards[0].gardenId'),null);
  assert.equal(run('state.cards[0].gardenPhotos.length'),1);
  assert.equal(run('state.childEntries.length'),1);
});

test('backup round trips every garden photo, caption and connection', () => {
  const run=app();
  run("state.gardenFolders.push({id:'f',section:'make',status:'paused',photos:[{src:'data:image/jpeg;base64,YWJj',caption:'Inspiration'}]});state.gardenEntries.push({id:'n',folderId:'f',date:todayISO(),photos:[{src:'data:image/jpeg;base64,YWJj',caption:'Progress'}]});addCard('m',todayISO());Object.assign(byId('m'),{gardenId:'f',gardenPhotos:[{src:'data:image/jpeg;base64,YWJj',caption:'Today'}]});const copy=normalizeState(JSON.parse(JSON.stringify(state)))");
  assert.equal(run('copy.gardenFolders[0].photos[0].caption'),'Inspiration');
  assert.equal(run('copy.gardenEntries[0].photos[0].caption'),'Progress');
  assert.equal(run('copy.cards[0].gardenPhotos[0].caption'),'Today');
  assert.equal(run('copy.cards[0].gardenId'),'f');
});

test('garden notes and links cannot inject markup or executable URLs', () => {
  const run=app();
  assert.equal(run("gardenGallery([{src:'javascript:alert(1)',caption:'Bad'}],'folder','f')"),'<div class="garden-gallery"></div>');
  assert.doesNotMatch(run("gardenMaterials('<img src=x onerror=alert(1)> javascript:alert(1)')"),/<img|href="javascript:/);
  assert.match(run("gardenMaterials('https://example.org/notes')"),/rel="noopener noreferrer"/);
  run("state.gardenFolders.push({id:'f',section:'later',title:'<script>bad</script>',photos:[]})");
  assert.doesNotMatch(run("renderGardenSection.call(null);gardenFolderRow(state.gardenFolders[0])"),/<script>/);
});
