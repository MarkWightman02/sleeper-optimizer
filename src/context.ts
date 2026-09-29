import { createContext, useContext } from 'react';
import type { AnalysisResult, PlayerEvaluation } from '../shared/types';

export const AnalysisContext = createContext<AnalysisResult | null>(null);

export function useAnalysis(): AnalysisResult {
  const analysis = useContext(AnalysisContext);
  if (!analysis) throw new Error('AnalysisContext is missing');
  return analysis;
}

export function playerLookup(analysis: AnalysisResult): Map<string, PlayerEvaluation> {
  const map = new Map<string, PlayerEvaluation>();
  const add = (player: PlayerEvaluation | null | undefined) => { if (player && !map.has(player.playerId)) map.set(player.playerId, player); };
  [...analysis.recommendedLineup, ...analysis.currentLineup].forEach(entry => add(entry.player));
  [...analysis.bench, ...analysis.reserve, ...analysis.taxi, ...analysis.freeAgents].forEach(add);
  return map;
}
