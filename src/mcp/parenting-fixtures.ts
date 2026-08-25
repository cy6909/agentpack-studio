export const PARENTING_SOURCE_VERSION = 'parenting-rules@1'

export interface ParentingRule {
  id: string
  severity: 'low' | 'medium' | 'high'
  activityIds: string[]
  maxAgeExclusive?: number
  constraint: string
  citation: string
}

export const PARENTING_RULES: readonly ParentingRule[] = [
  {
    id: 'rule-water-arm-reach',
    severity: 'high',
    activityIds: ['boat-ride', 'waterfront-walk'],
    maxAgeExclusive: 8,
    constraint: 'An adult must remain within arm reach near open water and the child must wear a correctly fitted life jacket on boats.',
    citation: 'fixture://parenting-safety/water#arm-reach',
  },
  {
    id: 'rule-vehicle-restraint',
    severity: 'high',
    activityIds: ['taxi-transfer'],
    maxAgeExclusive: 8,
    constraint: 'Use an age- and size-appropriate child restraint for every vehicle transfer.',
    citation: 'fixture://parenting-safety/transport#restraint',
  },
  {
    id: 'rule-sun-hydration',
    severity: 'medium',
    activityIds: ['waterfront-walk', 'garden-visit'],
    constraint: 'Schedule shade and hydration breaks and use sun protection.',
    citation: 'fixture://parenting-safety/outdoor#sun',
  },
  {
    id: 'rule-rest-window',
    severity: 'low',
    activityIds: ['garden-visit', 'museum-visit', 'waterfront-walk'],
    maxAgeExclusive: 7,
    constraint: 'Keep one quiet rest window in the afternoon.',
    citation: 'fixture://parenting-safety/routine#rest',
  },
]

export function applicableRules(childAge: number, activityIds: readonly string[]): ParentingRule[] {
  return PARENTING_RULES.filter(rule =>
    rule.activityIds.some(activity => activityIds.includes(activity))
    && (rule.maxAgeExclusive === undefined || childAge < rule.maxAgeExclusive),
  )
}
