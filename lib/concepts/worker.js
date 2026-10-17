import {startConceptRun, runConceptStage, supplementalConcepts, conceptRunSummary, DETECTORS} from './runtime.js';
import {studyEnabled, selectedGroups} from './controls.js';
const provenance = fetch(new URL('./integration-provenance.json', import.meta.url)).then(async response => {
  if (!response.ok) throw Error('Concept scope registry unavailable');
  return response.json();
});
self.onmessage = async ({data: {key, input}}) => {
  const started = performance.now(); let facts;
  const send = (phase, result) => self.postMessage({key, phase, result: {...result, timeMs:performance.now()-started}});
  try {
    const p = await provenance;
    const heavy = selectedGroups(input).some(id=>['tactics','endgames','positional','policies'].includes(id));
    let job = startConceptRun(input, p, !heavy);
    supplementalConcepts(job, 'fast');
    facts = conceptRunSummary(job); send('facts', facts);
    // Heavy profiles retain a cheap first checkpoint before the old bounded
    // parent searches. Fast profiles compute their parent only once.
    if (heavy) {
      const early = job;
      await new Promise(resolve=>setTimeout(resolve,0));
      job = startConceptRun(input, p);
      job.result.events.push(...early.result.events.filter(e=>e.integrationStudy));
      job.change = early.change; job.stages = early.stages; job.errors = early.errors;
    }
    const firstFacts = facts;
    let lastPublished = performance.now();
    const checkpoint = phase => {
      const now = performance.now();
      if (phase === 'progress' && now - lastPublished < 125) return;
      lastPublished = now; facts = conceptRunSummary(job);
      for (const f of firstFacts.findings) if (!facts.findings.some(old=>old.name===f.name&&old.text===f.text)) facts.findings.push(f);
      send(phase, facts);
    };
    for (const detector of DETECTORS.filter(d=>studyEnabled(input,d.study))) {
      await new Promise(resolve=>setTimeout(resolve,0));
      runConceptStage(job, detector); checkpoint('progress');
    }
    supplementalConcepts(job, 'deep'); checkpoint('complete');
  } catch (error) { send('complete', {...facts, findings:facts?.findings||[], issues:facts?.issues||[], unavailable:facts?.unavailable||[], errors:[error.message]}); }
};
