import {validateExercise} from './validation.js';
self.onmessage = ({data}) => {try {self.postMessage({id:data.id, result:validateExercise(data.exercise, data.answer)});} catch (error) {self.postMessage({id:data.id, result:{status:'inconclusive', feedback:error.message}});}};
