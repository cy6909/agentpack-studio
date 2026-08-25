export const TRAVEL_SOURCE_VERSION = 'travel-facts@1'

export const DESTINATIONS = {
  'hangzhou-west-lake': {
    id: 'hangzhou-west-lake',
    name: 'Hangzhou West Lake',
    climate: 'mild',
    factIds: ['dest-west-lake-weather', 'dest-west-lake-transit'],
    notes: ['Weather can change quickly near the lake.', 'Public transit and short taxi transfers are practical.'],
  },
  'sanya-bay': {
    id: 'sanya-bay',
    name: 'Sanya Bay',
    climate: 'warm',
    factIds: ['dest-sanya-heat', 'dest-sanya-water'],
    notes: ['Midday heat and UV exposure can be high.', 'Waterfront activities require weather checks.'],
  },
} as const

export const ACTIVITIES = {
  'boat-ride': { id: 'boat-ride', durationMinutes: 60, indoor: false, factId: 'activity-boat-ride' },
  'waterfront-walk': { id: 'waterfront-walk', durationMinutes: 90, indoor: false, factId: 'activity-waterfront-walk' },
  'taxi-transfer': { id: 'taxi-transfer', durationMinutes: 30, indoor: true, factId: 'activity-taxi-transfer' },
  'garden-visit': { id: 'garden-visit', durationMinutes: 120, indoor: false, factId: 'activity-garden-visit' },
  'museum-visit': { id: 'museum-visit', durationMinutes: 120, indoor: true, factId: 'activity-museum-visit' },
} as const
