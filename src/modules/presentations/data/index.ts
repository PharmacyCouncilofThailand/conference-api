import { approvedRound1Abstracts } from './approvedRound1Abstracts.js';
import { approvedRound2Abstracts } from './approvedRound2Abstracts.js';
export const loadPresentationAnnouncements = () => [...approvedRound1Abstracts, ...approvedRound2Abstracts];
// Round 2 is the consolidated current roster; Round 1 remains public history.
export const loadCurrentPresentationAnnouncements = () => approvedRound2Abstracts.length ? [...approvedRound2Abstracts] : [...approvedRound1Abstracts];
