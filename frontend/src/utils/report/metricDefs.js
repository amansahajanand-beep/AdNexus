export const METRIC_DEFS = {
  impressions: {
    label: 'Impressions',
    text: 'Ads served. GAM field: TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS.',
  },
  revenue: {
    label: 'Revenue',
    text: 'Line-item CPM + CPC revenue for the selected range. GAM field: TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE.',
  },
  ecpm: {
    label: 'eCPM',
    text: 'Effective cost per mille. Revenue ÷ impressions × 1000. GAM field: TOTAL_LINE_ITEM_LEVEL_WITHOUT_CPD_AVERAGE_ECPM.',
  },
  viewability: {
    label: 'Viewability',
    text: 'Share of impressions that were viewable (Active View). GAM field: TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE.',
  },
};
