import { approvedRound1Abstracts } from './approvedRound1Abstracts.js';
import { approvedRound2Abstracts } from './approvedRound2Abstracts.js';
export const loadPresentationAnnouncements = () => [...approvedRound1Abstracts, ...approvedRound2Abstracts];
