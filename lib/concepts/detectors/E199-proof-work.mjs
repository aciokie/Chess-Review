export function proofWork(value){let count=0;const pending=[value];while(pending.length){const v=pending.pop();count++;if(v&&typeof v==='object')pending.push(...Object.values(v));}return count;}
