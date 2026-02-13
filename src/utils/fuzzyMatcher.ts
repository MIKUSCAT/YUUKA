import {
  matchAdvanced,
  matchManyAdvanced,
  type MatchResult as AdvancedMatchResult,
} from './advancedFuzzyMatcher'

export type MatchResult = AdvancedMatchResult

export function matchCommand(command: string, query: string): MatchResult {
  return matchAdvanced(command, query)
}

export function matchCommands(
  commands: string[],
  query: string,
): Array<{ command: string; score: number }> {
  return matchManyAdvanced(commands, query, 5).map(item => ({
    command: item.candidate,
    score: item.score,
  }))
}
