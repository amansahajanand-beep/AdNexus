/**
 * AUTO-GENERATED from GAM API v202505 Dimension + Column enums.
 * 180 dimensions · 364 metrics — matches real Ad Manager report builder.
 * Regenerate: node scripts/buildGamCatalog.js
 */

export const GAM_DIMENSION_CATEGORIES = [
  {
    "id": "time",
    "label": "Time",
    "items": [
      {
        "id": "month_and_year",
        "label": "Month and year",
        "api": "MONTH_AND_YEAR"
      },
      {
        "id": "week",
        "label": "Week",
        "api": "WEEK"
      },
      {
        "id": "date",
        "label": "Date",
        "api": "DATE"
      },
      {
        "id": "day",
        "label": "Day of week",
        "api": "DAY"
      },
      {
        "id": "hour",
        "label": "Hour",
        "api": "HOUR"
      },
      {
        "id": "date_pt",
        "label": "Date Pt",
        "api": "DATE_PT"
      },
      {
        "id": "week_pt",
        "label": "Week Pt",
        "api": "WEEK_PT"
      },
      {
        "id": "month_year_pt",
        "label": "Month Year Pt",
        "api": "MONTH_YEAR_PT"
      },
      {
        "id": "day_of_week_pt",
        "label": "Day Of Week Pt",
        "api": "DAY_OF_WEEK_PT"
      }
    ]
  },
  {
    "id": "userGeography",
    "label": "User geography",
    "items": [
      {
        "id": "country_criteria_id",
        "label": "Country Criteria Id",
        "api": "COUNTRY_CRITERIA_ID"
      },
      {
        "id": "country_code",
        "label": "Country Code",
        "api": "COUNTRY_CODE"
      },
      {
        "id": "country_name",
        "label": "Country",
        "api": "COUNTRY_NAME"
      },
      {
        "id": "region_criteria_id",
        "label": "Region Criteria Id",
        "api": "REGION_CRITERIA_ID"
      },
      {
        "id": "region_name",
        "label": "Region",
        "api": "REGION_NAME"
      },
      {
        "id": "city_criteria_id",
        "label": "City Criteria Id",
        "api": "CITY_CRITERIA_ID"
      },
      {
        "id": "city_name",
        "label": "City",
        "api": "CITY_NAME"
      },
      {
        "id": "metro_criteria_id",
        "label": "Metro Criteria Id",
        "api": "METRO_CRITERIA_ID"
      },
      {
        "id": "metro_name",
        "label": "Metro",
        "api": "METRO_NAME"
      },
      {
        "id": "postal_code_criteria_id",
        "label": "Postal Code Criteria Id",
        "api": "POSTAL_CODE_CRITERIA_ID"
      },
      {
        "id": "postal_code",
        "label": "Postal code",
        "api": "POSTAL_CODE"
      }
    ]
  },
  {
    "id": "inventory",
    "label": "Inventory",
    "items": [
      {
        "id": "ad_unit_id",
        "label": "Ad Unit Id",
        "api": "AD_UNIT_ID"
      },
      {
        "id": "ad_unit_name",
        "label": "Ad unit",
        "api": "AD_UNIT_NAME"
      },
      {
        "id": "parent_ad_unit_id",
        "label": "Parent Ad Unit Id",
        "api": "PARENT_AD_UNIT_ID"
      },
      {
        "id": "parent_ad_unit_name",
        "label": "Parent Ad Unit Name",
        "api": "PARENT_AD_UNIT_NAME"
      },
      {
        "id": "placement_id",
        "label": "Placement Id",
        "api": "PLACEMENT_ID"
      },
      {
        "id": "placement_name",
        "label": "Placement",
        "api": "PLACEMENT_NAME"
      },
      {
        "id": "placement_status",
        "label": "Placement Status",
        "api": "PLACEMENT_STATUS"
      },
      {
        "id": "inventory_format",
        "label": "Inventory Format",
        "api": "INVENTORY_FORMAT"
      },
      {
        "id": "inventory_format_name",
        "label": "Inventory format",
        "api": "INVENTORY_FORMAT_NAME"
      },
      {
        "id": "ad_request_ad_unit_sizes",
        "label": "Ad request sizes",
        "api": "AD_REQUEST_AD_UNIT_SIZES"
      },
      {
        "id": "mobile_app_resolved_id",
        "label": "App ID",
        "api": "MOBILE_APP_RESOLVED_ID"
      },
      {
        "id": "mobile_app_name",
        "label": "App names",
        "api": "MOBILE_APP_NAME"
      },
      {
        "id": "mobile_device_name",
        "label": "Mobile OS",
        "api": "MOBILE_DEVICE_NAME"
      },
      {
        "id": "mobile_inventory_type",
        "label": "Inventory types",
        "api": "MOBILE_INVENTORY_TYPE"
      },
      {
        "id": "request_type",
        "label": "Request type",
        "api": "REQUEST_TYPE"
      },
      {
        "id": "ad_unit_status",
        "label": "Ad Unit Status",
        "api": "AD_UNIT_STATUS"
      },
      {
        "id": "web_property_code",
        "label": "Web Property Code",
        "api": "WEB_PROPERTY_CODE"
      },
      {
        "id": "advertiser_domain_name",
        "label": "Advertiser domain",
        "api": "ADVERTISER_DOMAIN_NAME"
      },
      {
        "id": "programmatic_channel_name",
        "label": "Programmatic channel",
        "api": "PROGRAMMATIC_CHANNEL_NAME"
      },
      {
        "id": "demand_channel_name",
        "label": "Demand channel",
        "api": "DEMAND_CHANNEL_NAME"
      },
      {
        "id": "domain",
        "label": "Domain",
        "api": "DOMAIN"
      },
      {
        "id": "ad_technology_provider_domain",
        "label": "Ad technology provider domain",
        "api": "AD_TECHNOLOGY_PROVIDER_DOMAIN"
      },
      {
        "id": "site_name",
        "label": "Site",
        "api": "SITE_NAME"
      },
      {
        "id": "channel_name",
        "label": "Channel",
        "api": "CHANNEL_NAME"
      },
      {
        "id": "url_id",
        "label": "Url Id",
        "api": "URL_ID"
      },
      {
        "id": "url_name",
        "label": "URL",
        "api": "URL_NAME"
      }
    ]
  },
  {
    "id": "video",
    "label": "Video",
    "items": [
      {
        "id": "video_fallback_position",
        "label": "Fallback position",
        "api": "VIDEO_FALLBACK_POSITION"
      },
      {
        "id": "position_of_pod",
        "label": "Position of pod",
        "api": "POSITION_OF_POD"
      },
      {
        "id": "position_in_pod",
        "label": "Position in pod",
        "api": "POSITION_IN_POD"
      },
      {
        "id": "video_redirect_third_party",
        "label": "Video redirect third party",
        "api": "VIDEO_REDIRECT_THIRD_PARTY"
      },
      {
        "id": "video_break_type",
        "label": "Video Break Type",
        "api": "VIDEO_BREAK_TYPE"
      },
      {
        "id": "video_break_type_name",
        "label": "Video Break Type Name",
        "api": "VIDEO_BREAK_TYPE_NAME"
      },
      {
        "id": "video_vast_version",
        "label": "VAST version",
        "api": "VIDEO_VAST_VERSION"
      },
      {
        "id": "video_ad_request_duration_id",
        "label": "Video Ad Request Duration Id",
        "api": "VIDEO_AD_REQUEST_DURATION_ID"
      },
      {
        "id": "video_ad_request_duration",
        "label": "Video ad request duration",
        "api": "VIDEO_AD_REQUEST_DURATION"
      },
      {
        "id": "video_plcmt_id",
        "label": "Video Plcmt Id",
        "api": "VIDEO_PLCMT_ID"
      },
      {
        "id": "video_plcmt_name",
        "label": "Video placement (new)",
        "api": "VIDEO_PLCMT_NAME"
      },
      {
        "id": "video_ad_duration",
        "label": "Video ad duration",
        "api": "VIDEO_AD_DURATION"
      },
      {
        "id": "video_ad_type_id",
        "label": "Video Ad Type Id",
        "api": "VIDEO_AD_TYPE_ID"
      },
      {
        "id": "video_ad_type_name",
        "label": "Video ad type",
        "api": "VIDEO_AD_TYPE_NAME"
      }
    ]
  },
  {
    "id": "delivery",
    "label": "Delivery",
    "items": [
      {
        "id": "line_item_id",
        "label": "Line Item Id",
        "api": "LINE_ITEM_ID"
      },
      {
        "id": "line_item_name",
        "label": "Line item",
        "api": "LINE_ITEM_NAME"
      },
      {
        "id": "line_item_type",
        "label": "Line item type",
        "api": "LINE_ITEM_TYPE"
      },
      {
        "id": "order_id",
        "label": "Order Id",
        "api": "ORDER_ID"
      },
      {
        "id": "order_name",
        "label": "Order",
        "api": "ORDER_NAME"
      },
      {
        "id": "order_delivery_status",
        "label": "Order Delivery Status",
        "api": "ORDER_DELIVERY_STATUS"
      },
      {
        "id": "advertiser_id",
        "label": "Advertiser Id",
        "api": "ADVERTISER_ID"
      },
      {
        "id": "advertiser_name",
        "label": "Advertiser",
        "api": "ADVERTISER_NAME"
      },
      {
        "id": "salesperson_id",
        "label": "Salesperson Id",
        "api": "SALESPERSON_ID"
      },
      {
        "id": "salesperson_name",
        "label": "Salesperson",
        "api": "SALESPERSON_NAME"
      },
      {
        "id": "creative_id",
        "label": "Creative Id",
        "api": "CREATIVE_ID"
      },
      {
        "id": "creative_name",
        "label": "Creative",
        "api": "CREATIVE_NAME"
      },
      {
        "id": "creative_type",
        "label": "Creative type",
        "api": "CREATIVE_TYPE"
      },
      {
        "id": "creative_billing_type",
        "label": "Creative billing type",
        "api": "CREATIVE_BILLING_TYPE"
      },
      {
        "id": "creative_size",
        "label": "Creative size",
        "api": "CREATIVE_SIZE"
      },
      {
        "id": "classified_advertiser_id",
        "label": "Classified Advertiser Id",
        "api": "CLASSIFIED_ADVERTISER_ID"
      },
      {
        "id": "classified_advertiser_name",
        "label": "Advertiser (classified)",
        "api": "CLASSIFIED_ADVERTISER_NAME"
      },
      {
        "id": "classified_brand_id",
        "label": "Classified Brand Id",
        "api": "CLASSIFIED_BRAND_ID"
      },
      {
        "id": "classified_brand_name",
        "label": "Brand (classified)",
        "api": "CLASSIFIED_BRAND_NAME"
      },
      {
        "id": "master_companion_creative_id",
        "label": "Master Companion Creative Id",
        "api": "MASTER_COMPANION_CREATIVE_ID"
      },
      {
        "id": "master_companion_creative_name",
        "label": "Master and Companion creative",
        "api": "MASTER_COMPANION_CREATIVE_NAME"
      },
      {
        "id": "buying_agency_name",
        "label": "Buying agency",
        "api": "BUYING_AGENCY_NAME"
      },
      {
        "id": "advertiser_vertical_name",
        "label": "Advertiser vertical",
        "api": "ADVERTISER_VERTICAL_NAME"
      },
      {
        "id": "creative_size_delivered",
        "label": "Creative size (delivered)",
        "api": "CREATIVE_SIZE_DELIVERED"
      }
    ]
  },
  {
    "id": "programmatic",
    "label": "Programmatic",
    "items": [
      {
        "id": "is_first_look_deal",
        "label": "Is First Look",
        "api": "IS_FIRST_LOOK_DEAL"
      },
      {
        "id": "is_adx_direct",
        "label": "Is AdX Direct",
        "api": "IS_ADX_DIRECT"
      },
      {
        "id": "yield_group_id",
        "label": "Yield Group Id",
        "api": "YIELD_GROUP_ID"
      },
      {
        "id": "yield_group_name",
        "label": "Yield group",
        "api": "YIELD_GROUP_NAME"
      },
      {
        "id": "yield_partner",
        "label": "Yield partner",
        "api": "YIELD_PARTNER"
      },
      {
        "id": "yield_partner_tag",
        "label": "Yield partner tag",
        "api": "YIELD_PARTNER_TAG"
      },
      {
        "id": "exchange_bidding_deal_id",
        "label": "Exchange bidding deal id",
        "api": "EXCHANGE_BIDDING_DEAL_ID"
      },
      {
        "id": "exchange_bidding_deal_type",
        "label": "Exchange bidding deal type",
        "api": "EXCHANGE_BIDDING_DEAL_TYPE"
      },
      {
        "id": "buyer_network_id",
        "label": "Buyer Network Id",
        "api": "BUYER_NETWORK_ID"
      },
      {
        "id": "buyer_network_name",
        "label": "Buyer network",
        "api": "BUYER_NETWORK_NAME"
      },
      {
        "id": "bidder_id",
        "label": "Bidder Id",
        "api": "BIDDER_ID"
      },
      {
        "id": "bidder_name",
        "label": "Bidder",
        "api": "BIDDER_NAME"
      },
      {
        "id": "programmatic_buyer_id",
        "label": "Programmatic Buyer Id",
        "api": "PROGRAMMATIC_BUYER_ID"
      },
      {
        "id": "programmatic_buyer_name",
        "label": "Programmatic buyer",
        "api": "PROGRAMMATIC_BUYER_NAME"
      },
      {
        "id": "programmatic_channel_id",
        "label": "Programmatic Channel Id",
        "api": "PROGRAMMATIC_CHANNEL_ID"
      },
      {
        "id": "classified_yield_partner_name",
        "label": "Yield partner (classified)",
        "api": "CLASSIFIED_YIELD_PARTNER_NAME"
      },
      {
        "id": "demand_channel_id",
        "label": "Demand Channel Id",
        "api": "DEMAND_CHANNEL_ID"
      },
      {
        "id": "programmatic_deal_id",
        "label": "Programmatic deal ID",
        "api": "PROGRAMMATIC_DEAL_ID"
      },
      {
        "id": "programmatic_deal_name",
        "label": "Programmatic deal name",
        "api": "PROGRAMMATIC_DEAL_NAME"
      }
    ]
  },
  {
    "id": "adTechnology",
    "label": "Ad technology",
    "items": [
      {
        "id": "targeting",
        "label": "Targeting",
        "api": "TARGETING"
      },
      {
        "id": "browser_name",
        "label": "Browser",
        "api": "BROWSER_NAME"
      },
      {
        "id": "device_category_id",
        "label": "Device Category Id",
        "api": "DEVICE_CATEGORY_ID"
      },
      {
        "id": "device_category_name",
        "label": "Device category",
        "api": "DEVICE_CATEGORY_NAME"
      },
      {
        "id": "custom_targeting_value_id",
        "label": "Custom Targeting Value Id",
        "api": "CUSTOM_TARGETING_VALUE_ID"
      },
      {
        "id": "operating_system_version_id",
        "label": "Operating System Version Id",
        "api": "OPERATING_SYSTEM_VERSION_ID"
      },
      {
        "id": "operating_system_version_name",
        "label": "Operating system",
        "api": "OPERATING_SYSTEM_VERSION_NAME"
      },
      {
        "id": "nielsen_device_id",
        "label": "Nielsen Device Id",
        "api": "NIELSEN_DEVICE_ID"
      },
      {
        "id": "nielsen_device_name",
        "label": "Nielsen Digital Ad Ratings device",
        "api": "NIELSEN_DEVICE_NAME"
      },
      {
        "id": "ad_type_id",
        "label": "Ad Type Id",
        "api": "AD_TYPE_ID"
      },
      {
        "id": "ad_type_name",
        "label": "Ad type",
        "api": "AD_TYPE_NAME"
      },
      {
        "id": "ad_location_id",
        "label": "Ad Location Id",
        "api": "AD_LOCATION_ID"
      },
      {
        "id": "ad_location_name",
        "label": "Ad location",
        "api": "AD_LOCATION_NAME"
      },
      {
        "id": "targeting_type_code",
        "label": "Targeting Type Code",
        "api": "TARGETING_TYPE_CODE"
      },
      {
        "id": "targeting_type_name",
        "label": "Targeting type",
        "api": "TARGETING_TYPE_NAME"
      },
      {
        "id": "branding_type_code",
        "label": "Branding Type Code",
        "api": "BRANDING_TYPE_CODE"
      },
      {
        "id": "branding_type_name",
        "label": "Branding type",
        "api": "BRANDING_TYPE_NAME"
      },
      {
        "id": "bandwidth_id",
        "label": "Bandwidth Id",
        "api": "BANDWIDTH_ID"
      },
      {
        "id": "bandwidth_name",
        "label": "Bandwidth",
        "api": "BANDWIDTH_NAME"
      },
      {
        "id": "carrier_id",
        "label": "Carrier Id",
        "api": "CARRIER_ID"
      },
      {
        "id": "carrier_name",
        "label": "Carrier",
        "api": "CARRIER_NAME"
      }
    ]
  },
  {
    "id": "audience",
    "label": "Audience",
    "items": [
      {
        "id": "grp_demographics",
        "label": "Demographics",
        "api": "GRP_DEMOGRAPHICS"
      },
      {
        "id": "audience_segment_id",
        "label": "Audience Segment Id",
        "api": "AUDIENCE_SEGMENT_ID"
      },
      {
        "id": "audience_segment_name",
        "label": "Audience segment (billable)",
        "api": "AUDIENCE_SEGMENT_NAME"
      },
      {
        "id": "audience_segment_data_provider_name",
        "label": "Data partner",
        "api": "AUDIENCE_SEGMENT_DATA_PROVIDER_NAME"
      },
      {
        "id": "nielsen_segment",
        "label": "Nielsen Digital Ad Ratings segment",
        "api": "NIELSEN_SEGMENT"
      },
      {
        "id": "nielsen_demographics",
        "label": "Nielsen Demographics",
        "api": "NIELSEN_DEMOGRAPHICS"
      },
      {
        "id": "nielsen_restatement_date",
        "label": "Nielsen Digital Ad Ratings restatement date",
        "api": "NIELSEN_RESTATEMENT_DATE"
      }
    ]
  },
  {
    "id": "content",
    "label": "Content",
    "items": [
      {
        "id": "content_id",
        "label": "Content Id",
        "api": "CONTENT_ID"
      },
      {
        "id": "content_name",
        "label": "Content",
        "api": "CONTENT_NAME"
      },
      {
        "id": "content_bundle_id",
        "label": "Content Bundle Id",
        "api": "CONTENT_BUNDLE_ID"
      },
      {
        "id": "content_bundle_name",
        "label": "Content bundle",
        "api": "CONTENT_BUNDLE_NAME"
      },
      {
        "id": "cms_metadata",
        "label": "Cms Metadata",
        "api": "CMS_METADATA"
      },
      {
        "id": "custom_spot_id",
        "label": "Custom Spot Id",
        "api": "CUSTOM_SPOT_ID"
      },
      {
        "id": "custom_spot_name",
        "label": "Custom spot",
        "api": "CUSTOM_SPOT_NAME"
      }
    ]
  },
  {
    "id": "partners",
    "label": "Partners",
    "items": [
      {
        "id": "partner_management_partner_id",
        "label": "Partner Management Partner Id",
        "api": "PARTNER_MANAGEMENT_PARTNER_ID"
      },
      {
        "id": "partner_management_partner_name",
        "label": "Partner",
        "api": "PARTNER_MANAGEMENT_PARTNER_NAME"
      },
      {
        "id": "partner_management_partner_label_id",
        "label": "Partner Management Partner Label Id",
        "api": "PARTNER_MANAGEMENT_PARTNER_LABEL_ID"
      },
      {
        "id": "partner_management_partner_label_name",
        "label": "Partner label",
        "api": "PARTNER_MANAGEMENT_PARTNER_LABEL_NAME"
      },
      {
        "id": "partner_management_assignment_id",
        "label": "Partner Management Assignment Id",
        "api": "PARTNER_MANAGEMENT_ASSIGNMENT_ID"
      },
      {
        "id": "partner_management_assignment_name",
        "label": "Assignment",
        "api": "PARTNER_MANAGEMENT_ASSIGNMENT_NAME"
      },
      {
        "id": "inventory_share_assignment_id",
        "label": "Inventory Share Assignment Id",
        "api": "INVENTORY_SHARE_ASSIGNMENT_ID"
      },
      {
        "id": "inventory_share_assignment_name",
        "label": "Inventory share assignment",
        "api": "INVENTORY_SHARE_ASSIGNMENT_NAME"
      },
      {
        "id": "inventory_share_outcome",
        "label": "Inventory share outcome",
        "api": "INVENTORY_SHARE_OUTCOME"
      }
    ]
  },
  {
    "id": "customTargeting",
    "label": "Custom targeting",
    "items": [
      {
        "id": "custom_event_id",
        "label": "Custom Event Id",
        "api": "CUSTOM_EVENT_ID"
      },
      {
        "id": "custom_event_name",
        "label": "Custom event",
        "api": "CUSTOM_EVENT_NAME"
      },
      {
        "id": "custom_event_type",
        "label": "Custom event type",
        "api": "CUSTOM_EVENT_TYPE"
      },
      {
        "id": "custom_criteria",
        "label": "Key-values",
        "api": "CUSTOM_CRITERIA"
      },
      {
        "id": "ad_request_custom_criteria",
        "label": "Ad Request Custom Criteria",
        "api": "AD_REQUEST_CUSTOM_CRITERIA"
      },
      {
        "id": "custom_dimension",
        "label": "Custom Dimension",
        "api": "CUSTOM_DIMENSION"
      }
    ]
  },
  {
    "id": "mediation",
    "label": "Mediation & SDK",
    "items": [
      {
        "id": "ad_network_id",
        "label": "Ad Network Id",
        "api": "AD_NETWORK_ID"
      },
      {
        "id": "ad_network_name",
        "label": "Ad network name",
        "api": "AD_NETWORK_NAME"
      },
      {
        "id": "mediation_type",
        "label": "Mediation type",
        "api": "MEDIATION_TYPE"
      },
      {
        "id": "native_template_id",
        "label": "Native Template Id",
        "api": "NATIVE_TEMPLATE_ID"
      },
      {
        "id": "native_template_name",
        "label": "Native ad format name",
        "api": "NATIVE_TEMPLATE_NAME"
      },
      {
        "id": "native_style_id",
        "label": "Native Style Id",
        "api": "NATIVE_STYLE_ID"
      },
      {
        "id": "native_style_name",
        "label": "Native style name",
        "api": "NATIVE_STYLE_NAME"
      }
    ]
  },
  {
    "id": "pricingBidding",
    "label": "Pricing & bidding",
    "items": [
      {
        "id": "serving_restriction_id",
        "label": "Serving Restriction Id",
        "api": "SERVING_RESTRICTION_ID"
      },
      {
        "id": "serving_restriction_name",
        "label": "Serving restriction",
        "api": "SERVING_RESTRICTION_NAME"
      },
      {
        "id": "unified_pricing_rule_id",
        "label": "Unified Pricing Rule Id",
        "api": "UNIFIED_PRICING_RULE_ID"
      },
      {
        "id": "unified_pricing_rule_name",
        "label": "Unified pricing rule",
        "api": "UNIFIED_PRICING_RULE_NAME"
      },
      {
        "id": "first_look_pricing_rule_id",
        "label": "First Look Pricing Rule Id",
        "api": "FIRST_LOOK_PRICING_RULE_ID"
      },
      {
        "id": "first_look_pricing_rule_name",
        "label": "First look pricing rule",
        "api": "FIRST_LOOK_PRICING_RULE_NAME"
      },
      {
        "id": "bid_range",
        "label": "Bid range",
        "api": "BID_RANGE"
      },
      {
        "id": "bid_rejection_reason",
        "label": "Bid Rejection Reason",
        "api": "BID_REJECTION_REASON"
      },
      {
        "id": "bid_rejection_reason_name",
        "label": "Bid rejection reason",
        "api": "BID_REJECTION_REASON_NAME"
      },
      {
        "id": "ad_technology_provider_id",
        "label": "Ad technology provider ID",
        "api": "AD_TECHNOLOGY_PROVIDER_ID"
      },
      {
        "id": "ad_technology_provider_name",
        "label": "Ad technology provider",
        "api": "AD_TECHNOLOGY_PROVIDER_NAME"
      },
      {
        "id": "tcf_vendor_id",
        "label": "TCF vendor ID",
        "api": "TCF_VENDOR_ID"
      },
      {
        "id": "tcf_vendor_name",
        "label": "TCF vendor",
        "api": "TCF_VENDOR_NAME"
      }
    ]
  },
  {
    "id": "other",
    "label": "Other",
    "items": [
      {
        "id": "child_network_code",
        "label": "Child network code",
        "api": "CHILD_NETWORK_CODE"
      },
      {
        "id": "ad_exchange_optimization_type",
        "label": "Optimization type",
        "api": "AD_EXCHANGE_OPTIMIZATION_TYPE"
      },
      {
        "id": "requested_ad_sizes",
        "label": "Requested ad sizes",
        "api": "REQUESTED_AD_SIZES"
      },
      {
        "id": "ad_exchange_product_code",
        "label": "Ad Exchange Product Code",
        "api": "AD_EXCHANGE_PRODUCT_CODE"
      },
      {
        "id": "ad_exchange_product_name",
        "label": "Ad Exchange product",
        "api": "AD_EXCHANGE_PRODUCT_NAME"
      },
      {
        "id": "dynamic_allocation_id",
        "label": "Dynamic Allocation Id",
        "api": "DYNAMIC_ALLOCATION_ID"
      },
      {
        "id": "dynamic_allocation_name",
        "label": "Dynamic allocation",
        "api": "DYNAMIC_ALLOCATION_NAME"
      }
    ]
  }
];

export const GAM_METRIC_CATEGORIES = [
  {
    "id": "video",
    "label": "Video",
    "items": [
      {
        "id": "rich_media_backup_images",
        "label": "Backup image impressions",
        "api": "RICH_MEDIA_BACKUP_IMAGES"
      },
      {
        "id": "rich_media_display_time",
        "label": "Total display time",
        "api": "RICH_MEDIA_DISPLAY_TIME"
      },
      {
        "id": "rich_media_average_display_time",
        "label": "Average display time",
        "api": "RICH_MEDIA_AVERAGE_DISPLAY_TIME"
      },
      {
        "id": "rich_media_expansions",
        "label": "Total expansions",
        "api": "RICH_MEDIA_EXPANSIONS"
      },
      {
        "id": "rich_media_expanding_time",
        "label": "Average expanding time",
        "api": "RICH_MEDIA_EXPANDING_TIME"
      },
      {
        "id": "rich_media_interaction_time",
        "label": "Interaction time",
        "api": "RICH_MEDIA_INTERACTION_TIME"
      },
      {
        "id": "rich_media_interaction_count",
        "label": "Total interactions",
        "api": "RICH_MEDIA_INTERACTION_COUNT"
      },
      {
        "id": "rich_media_interaction_rate",
        "label": "Interaction rate",
        "api": "RICH_MEDIA_INTERACTION_RATE"
      },
      {
        "id": "rich_media_average_interaction_time",
        "label": "Average interaction time",
        "api": "RICH_MEDIA_AVERAGE_INTERACTION_TIME"
      },
      {
        "id": "rich_media_interaction_impressions",
        "label": "Interactive impressions",
        "api": "RICH_MEDIA_INTERACTION_IMPRESSIONS"
      },
      {
        "id": "rich_media_manual_closes",
        "label": "Manual closes",
        "api": "RICH_MEDIA_MANUAL_CLOSES"
      },
      {
        "id": "rich_media_full_screen_impressions",
        "label": "Full-screen impressions",
        "api": "RICH_MEDIA_FULL_SCREEN_IMPRESSIONS"
      },
      {
        "id": "rich_media_video_interactions",
        "label": "Total video interactions",
        "api": "RICH_MEDIA_VIDEO_INTERACTIONS"
      },
      {
        "id": "rich_media_video_interaction_rate",
        "label": "Video interaction rate",
        "api": "RICH_MEDIA_VIDEO_INTERACTION_RATE"
      },
      {
        "id": "rich_media_video_mutes",
        "label": "Mute",
        "api": "RICH_MEDIA_VIDEO_MUTES"
      },
      {
        "id": "rich_media_video_pauses",
        "label": "Pause",
        "api": "RICH_MEDIA_VIDEO_PAUSES"
      },
      {
        "id": "rich_media_video_playes",
        "label": "Plays",
        "api": "RICH_MEDIA_VIDEO_PLAYES"
      },
      {
        "id": "rich_media_video_midpoints",
        "label": "Midpoint",
        "api": "RICH_MEDIA_VIDEO_MIDPOINTS"
      },
      {
        "id": "rich_media_video_completes",
        "label": "Complete",
        "api": "RICH_MEDIA_VIDEO_COMPLETES"
      },
      {
        "id": "rich_media_video_replays",
        "label": "Replays",
        "api": "RICH_MEDIA_VIDEO_REPLAYS"
      },
      {
        "id": "rich_media_video_stops",
        "label": "Stops",
        "api": "RICH_MEDIA_VIDEO_STOPS"
      },
      {
        "id": "rich_media_video_unmutes",
        "label": "Unmute",
        "api": "RICH_MEDIA_VIDEO_UNMUTES"
      },
      {
        "id": "rich_media_video_view_time",
        "label": "Average view time",
        "api": "RICH_MEDIA_VIDEO_VIEW_TIME"
      },
      {
        "id": "rich_media_video_view_rate",
        "label": "View rate",
        "api": "RICH_MEDIA_VIDEO_VIEW_RATE"
      },
      {
        "id": "rich_media_custom_event_time",
        "label": "Custom event - time",
        "api": "RICH_MEDIA_CUSTOM_EVENT_TIME"
      },
      {
        "id": "rich_media_custom_event_count",
        "label": "Custom event - count",
        "api": "RICH_MEDIA_CUSTOM_EVENT_COUNT"
      },
      {
        "id": "video_viewership_start",
        "label": "Start",
        "api": "VIDEO_VIEWERSHIP_START"
      },
      {
        "id": "video_viewership_first_quartile",
        "label": "First quartile",
        "api": "VIDEO_VIEWERSHIP_FIRST_QUARTILE"
      },
      {
        "id": "video_viewership_midpoint",
        "label": "Midpoint",
        "api": "VIDEO_VIEWERSHIP_MIDPOINT"
      },
      {
        "id": "video_viewership_third_quartile",
        "label": "Third quartile",
        "api": "VIDEO_VIEWERSHIP_THIRD_QUARTILE"
      },
      {
        "id": "video_viewership_complete",
        "label": "Complete",
        "api": "VIDEO_VIEWERSHIP_COMPLETE"
      },
      {
        "id": "video_viewership_average_view_rate",
        "label": "Average view rate",
        "api": "VIDEO_VIEWERSHIP_AVERAGE_VIEW_RATE"
      },
      {
        "id": "video_viewership_average_view_time",
        "label": "Average view time",
        "api": "VIDEO_VIEWERSHIP_AVERAGE_VIEW_TIME"
      },
      {
        "id": "video_viewership_completion_rate",
        "label": "Completion rate",
        "api": "VIDEO_VIEWERSHIP_COMPLETION_RATE"
      },
      {
        "id": "video_viewership_total_error_count",
        "label": "Total error count",
        "api": "VIDEO_VIEWERSHIP_TOTAL_ERROR_COUNT"
      },
      {
        "id": "video_viewership_video_length",
        "label": "Video length",
        "api": "VIDEO_VIEWERSHIP_VIDEO_LENGTH"
      },
      {
        "id": "video_viewership_skip_button_shown",
        "label": "Skip button shown",
        "api": "VIDEO_VIEWERSHIP_SKIP_BUTTON_SHOWN"
      },
      {
        "id": "video_viewership_engaged_view",
        "label": "Engaged view",
        "api": "VIDEO_VIEWERSHIP_ENGAGED_VIEW"
      },
      {
        "id": "video_viewership_view_through_rate",
        "label": "View-through rate",
        "api": "VIDEO_VIEWERSHIP_VIEW_THROUGH_RATE"
      },
      {
        "id": "video_viewership_auto_plays",
        "label": "Auto-plays",
        "api": "VIDEO_VIEWERSHIP_AUTO_PLAYS"
      },
      {
        "id": "video_viewership_click_to_plays",
        "label": "Click-to-plays",
        "api": "VIDEO_VIEWERSHIP_CLICK_TO_PLAYS"
      },
      {
        "id": "video_viewership_total_error_rate",
        "label": "Total error rate",
        "api": "VIDEO_VIEWERSHIP_TOTAL_ERROR_RATE"
      },
      {
        "id": "dropoff_rate",
        "label": "Drop-off rate",
        "api": "DROPOFF_RATE"
      },
      {
        "id": "video_trueview_views",
        "label": "TrueView views",
        "api": "VIDEO_TRUEVIEW_VIEWS"
      },
      {
        "id": "video_trueview_skip_rate",
        "label": "TrueView skip rate",
        "api": "VIDEO_TRUEVIEW_SKIP_RATE"
      },
      {
        "id": "video_trueview_vtr",
        "label": "TrueView VTR",
        "api": "VIDEO_TRUEVIEW_VTR"
      },
      {
        "id": "video_errors_vast_error_100_count",
        "label": "VAST error 100 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_100_COUNT"
      },
      {
        "id": "video_errors_vast_error_101_count",
        "label": "VAST error 101 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_101_COUNT"
      },
      {
        "id": "video_errors_vast_error_102_count",
        "label": "VAST error 102 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_102_COUNT"
      },
      {
        "id": "video_errors_vast_error_200_count",
        "label": "VAST error 200 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_200_COUNT"
      },
      {
        "id": "video_errors_vast_error_201_count",
        "label": "VAST error 201 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_201_COUNT"
      },
      {
        "id": "video_errors_vast_error_202_count",
        "label": "VAST error 202 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_202_COUNT"
      },
      {
        "id": "video_errors_vast_error_203_count",
        "label": "VAST error 203 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_203_COUNT"
      },
      {
        "id": "video_errors_vast_error_300_count",
        "label": "VAST error 300 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_300_COUNT"
      },
      {
        "id": "video_errors_vast_error_301_count",
        "label": "VAST error 301 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_301_COUNT"
      },
      {
        "id": "video_errors_vast_error_302_count",
        "label": "VAST error 302 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_302_COUNT"
      },
      {
        "id": "video_errors_vast_error_303_count",
        "label": "VAST error 303 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_303_COUNT"
      },
      {
        "id": "video_errors_vast_error_400_count",
        "label": "VAST error 400 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_400_COUNT"
      },
      {
        "id": "video_errors_vast_error_401_count",
        "label": "VAST error 401 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_401_COUNT"
      },
      {
        "id": "video_errors_vast_error_402_count",
        "label": "VAST error 402 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_402_COUNT"
      },
      {
        "id": "video_errors_vast_error_403_count",
        "label": "VAST error 403 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_403_COUNT"
      },
      {
        "id": "video_errors_vast_error_405_count",
        "label": "VAST error 405 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_405_COUNT"
      },
      {
        "id": "video_errors_vast_error_500_count",
        "label": "VAST error 500 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_500_COUNT"
      },
      {
        "id": "video_errors_vast_error_501_count",
        "label": "VAST error 501 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_501_COUNT"
      },
      {
        "id": "video_errors_vast_error_502_count",
        "label": "VAST error 502 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_502_COUNT"
      },
      {
        "id": "video_errors_vast_error_503_count",
        "label": "VAST error 503 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_503_COUNT"
      },
      {
        "id": "video_errors_vast_error_600_count",
        "label": "VAST error 600 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_600_COUNT"
      },
      {
        "id": "video_errors_vast_error_601_count",
        "label": "VAST error 601 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_601_COUNT"
      },
      {
        "id": "video_errors_vast_error_602_count",
        "label": "VAST error 602 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_602_COUNT"
      },
      {
        "id": "video_errors_vast_error_603_count",
        "label": "VAST error 603 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_603_COUNT"
      },
      {
        "id": "video_errors_vast_error_604_count",
        "label": "VAST error 604 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_604_COUNT"
      },
      {
        "id": "video_errors_vast_error_900_count",
        "label": "VAST error 900 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_900_COUNT"
      },
      {
        "id": "video_errors_vast_error_901_count",
        "label": "VAST error 901 count",
        "api": "VIDEO_ERRORS_VAST_ERROR_901_COUNT"
      },
      {
        "id": "video_interaction_pause",
        "label": "Pause",
        "api": "VIDEO_INTERACTION_PAUSE"
      },
      {
        "id": "video_interaction_resume",
        "label": "Resume",
        "api": "VIDEO_INTERACTION_RESUME"
      },
      {
        "id": "video_interaction_rewind",
        "label": "Rewind",
        "api": "VIDEO_INTERACTION_REWIND"
      },
      {
        "id": "video_interaction_mute",
        "label": "Mute",
        "api": "VIDEO_INTERACTION_MUTE"
      },
      {
        "id": "video_interaction_unmute",
        "label": "Unmute",
        "api": "VIDEO_INTERACTION_UNMUTE"
      },
      {
        "id": "video_interaction_collapse",
        "label": "Collapse",
        "api": "VIDEO_INTERACTION_COLLAPSE"
      },
      {
        "id": "video_interaction_expand",
        "label": "Expand",
        "api": "VIDEO_INTERACTION_EXPAND"
      },
      {
        "id": "video_interaction_full_screen",
        "label": "Full screen",
        "api": "VIDEO_INTERACTION_FULL_SCREEN"
      },
      {
        "id": "video_interaction_average_interaction_rate",
        "label": "Average interaction rate",
        "api": "VIDEO_INTERACTION_AVERAGE_INTERACTION_RATE"
      },
      {
        "id": "video_interaction_video_skips",
        "label": "Video skipped",
        "api": "VIDEO_INTERACTION_VIDEO_SKIPS"
      },
      {
        "id": "video_optimization_control_starts",
        "label": "Control starts",
        "api": "VIDEO_OPTIMIZATION_CONTROL_STARTS"
      },
      {
        "id": "video_optimization_optimized_starts",
        "label": "Optimized starts",
        "api": "VIDEO_OPTIMIZATION_OPTIMIZED_STARTS"
      },
      {
        "id": "video_optimization_control_completes",
        "label": "Control completes",
        "api": "VIDEO_OPTIMIZATION_CONTROL_COMPLETES"
      },
      {
        "id": "video_optimization_optimized_completes",
        "label": "Optimized completes",
        "api": "VIDEO_OPTIMIZATION_OPTIMIZED_COMPLETES"
      },
      {
        "id": "video_optimization_control_completion_rate",
        "label": "Control completion rate",
        "api": "VIDEO_OPTIMIZATION_CONTROL_COMPLETION_RATE"
      },
      {
        "id": "video_optimization_optimized_completion_rate",
        "label": "Optimized completion rate",
        "api": "VIDEO_OPTIMIZATION_OPTIMIZED_COMPLETION_RATE"
      },
      {
        "id": "video_optimization_completion_rate_lift",
        "label": "Completion rate lift",
        "api": "VIDEO_OPTIMIZATION_COMPLETION_RATE_LIFT"
      },
      {
        "id": "video_optimization_control_skip_button_shown",
        "label": "Control skip button shown",
        "api": "VIDEO_OPTIMIZATION_CONTROL_SKIP_BUTTON_SHOWN"
      },
      {
        "id": "video_optimization_optimized_skip_button_shown",
        "label": "Optimized skip button shown",
        "api": "VIDEO_OPTIMIZATION_OPTIMIZED_SKIP_BUTTON_SHOWN"
      },
      {
        "id": "video_optimization_control_engaged_view",
        "label": "Control engaged view",
        "api": "VIDEO_OPTIMIZATION_CONTROL_ENGAGED_VIEW"
      },
      {
        "id": "video_optimization_optimized_engaged_view",
        "label": "Optimized engaged view",
        "api": "VIDEO_OPTIMIZATION_OPTIMIZED_ENGAGED_VIEW"
      },
      {
        "id": "video_optimization_control_view_through_rate",
        "label": "Control view-through rate",
        "api": "VIDEO_OPTIMIZATION_CONTROL_VIEW_THROUGH_RATE"
      },
      {
        "id": "video_optimization_optimized_view_through_rate",
        "label": "Optimized view-through rate",
        "api": "VIDEO_OPTIMIZATION_OPTIMIZED_VIEW_THROUGH_RATE"
      },
      {
        "id": "video_optimization_view_through_rate_lift",
        "label": "View-through rate lift",
        "api": "VIDEO_OPTIMIZATION_VIEW_THROUGH_RATE_LIFT"
      },
      {
        "id": "video_impressions_real_time",
        "label": "Total impressions",
        "api": "VIDEO_IMPRESSIONS_REAL_TIME"
      },
      {
        "id": "video_matched_queries_real_time",
        "label": "Total responses served",
        "api": "VIDEO_MATCHED_QUERIES_REAL_TIME"
      },
      {
        "id": "video_unmatched_queries_real_time",
        "label": "Total unmatched ad requests",
        "api": "VIDEO_UNMATCHED_QUERIES_REAL_TIME"
      },
      {
        "id": "video_total_queries_real_time",
        "label": "Total ad requests",
        "api": "VIDEO_TOTAL_QUERIES_REAL_TIME"
      },
      {
        "id": "video_creative_serve_real_time",
        "label": "Total creative serves",
        "api": "VIDEO_CREATIVE_SERVE_REAL_TIME"
      },
      {
        "id": "video_vast3_error_100_count_real_time",
        "label": "VAST error 100 count",
        "api": "VIDEO_VAST3_ERROR_100_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_101_count_real_time",
        "label": "VAST error 101 count",
        "api": "VIDEO_VAST3_ERROR_101_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_102_count_real_time",
        "label": "VAST error 102 count",
        "api": "VIDEO_VAST3_ERROR_102_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_200_count_real_time",
        "label": "VAST error 200 count",
        "api": "VIDEO_VAST3_ERROR_200_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_201_count_real_time",
        "label": "VAST error 201 count",
        "api": "VIDEO_VAST3_ERROR_201_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_202_count_real_time",
        "label": "VAST error 202 count",
        "api": "VIDEO_VAST3_ERROR_202_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_203_count_real_time",
        "label": "VAST error 203 count",
        "api": "VIDEO_VAST3_ERROR_203_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_300_count_real_time",
        "label": "VAST error 300 count",
        "api": "VIDEO_VAST3_ERROR_300_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_301_count_real_time",
        "label": "VAST error 301 count",
        "api": "VIDEO_VAST3_ERROR_301_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_302_count_real_time",
        "label": "VAST error 302 count",
        "api": "VIDEO_VAST3_ERROR_302_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_303_count_real_time",
        "label": "VAST error 303 count",
        "api": "VIDEO_VAST3_ERROR_303_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_400_count_real_time",
        "label": "VAST error 400 count",
        "api": "VIDEO_VAST3_ERROR_400_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_401_count_real_time",
        "label": "VAST error 401 count",
        "api": "VIDEO_VAST3_ERROR_401_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_402_count_real_time",
        "label": "VAST error 402 count",
        "api": "VIDEO_VAST3_ERROR_402_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_403_count_real_time",
        "label": "VAST error 403 count",
        "api": "VIDEO_VAST3_ERROR_403_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_405_count_real_time",
        "label": "VAST error 405 count",
        "api": "VIDEO_VAST3_ERROR_405_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_500_count_real_time",
        "label": "VAST error 500 count",
        "api": "VIDEO_VAST3_ERROR_500_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_501_count_real_time",
        "label": "VAST error 501 count",
        "api": "VIDEO_VAST3_ERROR_501_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_502_count_real_time",
        "label": "VAST error 502 count",
        "api": "VIDEO_VAST3_ERROR_502_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_503_count_real_time",
        "label": "VAST error 503 count",
        "api": "VIDEO_VAST3_ERROR_503_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_600_count_real_time",
        "label": "VAST error 600 count",
        "api": "VIDEO_VAST3_ERROR_600_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_601_count_real_time",
        "label": "VAST error 601 count",
        "api": "VIDEO_VAST3_ERROR_601_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_602_count_real_time",
        "label": "VAST error 602 count",
        "api": "VIDEO_VAST3_ERROR_602_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_603_count_real_time",
        "label": "VAST error 603 count",
        "api": "VIDEO_VAST3_ERROR_603_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_604_count_real_time",
        "label": "VAST error 604 count",
        "api": "VIDEO_VAST3_ERROR_604_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_900_count_real_time",
        "label": "VAST error 900 count",
        "api": "VIDEO_VAST3_ERROR_900_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast3_error_901_count_real_time",
        "label": "VAST error 901 count",
        "api": "VIDEO_VAST3_ERROR_901_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast4_error_406_count_real_time",
        "label": "VAST error 406 count",
        "api": "VIDEO_VAST4_ERROR_406_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast4_error_407_count_real_time",
        "label": "VAST error 407 count",
        "api": "VIDEO_VAST4_ERROR_407_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast4_error_408_count_real_time",
        "label": "VAST error 408 count",
        "api": "VIDEO_VAST4_ERROR_408_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast4_error_409_count_real_time",
        "label": "VAST error 409 count",
        "api": "VIDEO_VAST4_ERROR_409_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast4_error_410_count_real_time",
        "label": "VAST error 410 count",
        "api": "VIDEO_VAST4_ERROR_410_COUNT_REAL_TIME"
      },
      {
        "id": "video_vast_total_error_count_real_time",
        "label": "Total error count",
        "api": "VIDEO_VAST_TOTAL_ERROR_COUNT_REAL_TIME"
      }
    ]
  },
  {
    "id": "programmatic",
    "label": "Programmatic",
    "items": [
      {
        "id": "bid_count",
        "label": "Bids",
        "api": "BID_COUNT"
      },
      {
        "id": "bid_average_cpm",
        "label": "Average bid CPM",
        "api": "BID_AVERAGE_CPM"
      },
      {
        "id": "yield_group_callouts",
        "label": "Yield group callouts",
        "api": "YIELD_GROUP_CALLOUTS"
      },
      {
        "id": "yield_group_successful_responses",
        "label": "Yield group successful responses",
        "api": "YIELD_GROUP_SUCCESSFUL_RESPONSES"
      },
      {
        "id": "yield_group_bids",
        "label": "Yield group bids",
        "api": "YIELD_GROUP_BIDS"
      },
      {
        "id": "yield_group_bids_in_auction",
        "label": "Yield group bids in auction",
        "api": "YIELD_GROUP_BIDS_IN_AUCTION"
      },
      {
        "id": "yield_group_auctions_won",
        "label": "Yield group auctions won",
        "api": "YIELD_GROUP_AUCTIONS_WON"
      },
      {
        "id": "deals_bid_requests",
        "label": "Deals bid requests",
        "api": "DEALS_BID_REQUESTS"
      },
      {
        "id": "deals_bids",
        "label": "Deals bids",
        "api": "DEALS_BIDS"
      },
      {
        "id": "deals_bid_rate",
        "label": "Deals bid rate",
        "api": "DEALS_BID_RATE"
      },
      {
        "id": "deals_winning_bids",
        "label": "Deals winning bids",
        "api": "DEALS_WINNING_BIDS"
      },
      {
        "id": "deals_win_rate",
        "label": "Deals win rate",
        "api": "DEALS_WIN_RATE"
      },
      {
        "id": "yield_group_impressions",
        "label": "Yield group impressions",
        "api": "YIELD_GROUP_IMPRESSIONS"
      },
      {
        "id": "yield_group_estimated_revenue",
        "label": "Yield group estimated revenue",
        "api": "YIELD_GROUP_ESTIMATED_REVENUE"
      },
      {
        "id": "yield_group_estimated_cpm",
        "label": "Yield group estimated CPM",
        "api": "YIELD_GROUP_ESTIMATED_CPM"
      },
      {
        "id": "yield_group_mediation_fill_rate",
        "label": "Mediation fill rate",
        "api": "YIELD_GROUP_MEDIATION_FILL_RATE"
      },
      {
        "id": "yield_group_mediation_passbacks",
        "label": "Mediation passbacks",
        "api": "YIELD_GROUP_MEDIATION_PASSBACKS"
      },
      {
        "id": "yield_group_mediation_third_party_ecpm",
        "label": "Mediation third-party eCPM",
        "api": "YIELD_GROUP_MEDIATION_THIRD_PARTY_ECPM"
      },
      {
        "id": "yield_group_mediation_chains_served",
        "label": "Mediation chains served",
        "api": "YIELD_GROUP_MEDIATION_CHAINS_SERVED"
      },
      {
        "id": "mediation_third_party_ecpm",
        "label": "Mediation Third Party Ecpm",
        "api": "MEDIATION_THIRD_PARTY_ECPM"
      },
      {
        "id": "programmatic_responses_served",
        "label": "Programmatic responses served",
        "api": "PROGRAMMATIC_RESPONSES_SERVED"
      },
      {
        "id": "programmatic_match_rate",
        "label": "Programmatic match rate",
        "api": "PROGRAMMATIC_MATCH_RATE"
      }
    ]
  },
  {
    "id": "other",
    "label": "Other",
    "items": [
      {
        "id": "dynamic_allocation_opportunity_impressions_competing_total",
        "label": "Impressions competing",
        "api": "DYNAMIC_ALLOCATION_OPPORTUNITY_IMPRESSIONS_COMPETING_TOTAL"
      },
      {
        "id": "dynamic_allocation_opportunity_unfilled_impressions_competing",
        "label": "Unfilled competing impressions",
        "api": "DYNAMIC_ALLOCATION_OPPORTUNITY_UNFILLED_IMPRESSIONS_COMPETING"
      },
      {
        "id": "dynamic_allocation_opportunity_eligible_impressions_total",
        "label": "Eligible impressions",
        "api": "DYNAMIC_ALLOCATION_OPPORTUNITY_ELIGIBLE_IMPRESSIONS_TOTAL"
      },
      {
        "id": "dynamic_allocation_opportunity_impressions_not_competing_total",
        "label": "Dynamic Allocation Opportunity Impressions Not Competing Total",
        "api": "DYNAMIC_ALLOCATION_OPPORTUNITY_IMPRESSIONS_NOT_COMPETING_TOTAL"
      },
      {
        "id": "dynamic_allocation_opportunity_impressions_not_competing_percent_total",
        "label": "Impressions not competing (%)",
        "api": "DYNAMIC_ALLOCATION_OPPORTUNITY_IMPRESSIONS_NOT_COMPETING_PERCENT_TOTAL"
      },
      {
        "id": "dynamic_allocation_opportunity_saturation_rate_total",
        "label": "Dynamic Allocation Opportunity Saturation Rate Total",
        "api": "DYNAMIC_ALLOCATION_OPPORTUNITY_SATURATION_RATE_TOTAL"
      },
      {
        "id": "dynamic_allocation_opportunity_match_rate_total",
        "label": "Dynamic allocation match rate",
        "api": "DYNAMIC_ALLOCATION_OPPORTUNITY_MATCH_RATE_TOTAL"
      },
      {
        "id": "invoiced_impressions",
        "label": "Invoiced impressions",
        "api": "INVOICED_IMPRESSIONS"
      },
      {
        "id": "invoiced_unfilled_impressions",
        "label": "Invoiced unfilled impressions",
        "api": "INVOICED_UNFILLED_IMPRESSIONS"
      },
      {
        "id": "nielsen_impressions",
        "label": "Impressions",
        "api": "NIELSEN_IMPRESSIONS"
      },
      {
        "id": "nielsen_in_target_impressions",
        "label": "In-target impressions",
        "api": "NIELSEN_IN_TARGET_IMPRESSIONS"
      },
      {
        "id": "nielsen_population_base",
        "label": "Population base",
        "api": "NIELSEN_POPULATION_BASE"
      },
      {
        "id": "nielsen_in_target_population_base",
        "label": "Nielsen In Target Population Base",
        "api": "NIELSEN_IN_TARGET_POPULATION_BASE"
      },
      {
        "id": "nielsen_unique_audience",
        "label": "Unique audience",
        "api": "NIELSEN_UNIQUE_AUDIENCE"
      },
      {
        "id": "nielsen_in_target_unique_audience",
        "label": "Nielsen In Target Unique Audience",
        "api": "NIELSEN_IN_TARGET_UNIQUE_AUDIENCE"
      },
      {
        "id": "nielsen_percent_audience_reach",
        "label": "% audience reach",
        "api": "NIELSEN_PERCENT_AUDIENCE_REACH"
      },
      {
        "id": "nielsen_in_target_percent_audience_reach",
        "label": "Nielsen In Target Percent Audience Reach",
        "api": "NIELSEN_IN_TARGET_PERCENT_AUDIENCE_REACH"
      },
      {
        "id": "nielsen_average_frequency",
        "label": "Average frequency",
        "api": "NIELSEN_AVERAGE_FREQUENCY"
      },
      {
        "id": "nielsen_in_target_average_frequency",
        "label": "Nielsen In Target Average Frequency",
        "api": "NIELSEN_IN_TARGET_AVERAGE_FREQUENCY"
      },
      {
        "id": "nielsen_gross_rating_points",
        "label": "Gross rating points",
        "api": "NIELSEN_GROSS_RATING_POINTS"
      },
      {
        "id": "nielsen_in_target_gross_rating_points",
        "label": "Nielsen In Target Gross Rating Points",
        "api": "NIELSEN_IN_TARGET_GROSS_RATING_POINTS"
      },
      {
        "id": "nielsen_percent_impressions_share",
        "label": "% impression share",
        "api": "NIELSEN_PERCENT_IMPRESSIONS_SHARE"
      },
      {
        "id": "nielsen_in_target_percent_impressions_share",
        "label": "In-target % impression share",
        "api": "NIELSEN_IN_TARGET_PERCENT_IMPRESSIONS_SHARE"
      },
      {
        "id": "nielsen_percent_population_share",
        "label": "% population share",
        "api": "NIELSEN_PERCENT_POPULATION_SHARE"
      },
      {
        "id": "nielsen_in_target_percent_population_share",
        "label": "Nielsen In Target Percent Population Share",
        "api": "NIELSEN_IN_TARGET_PERCENT_POPULATION_SHARE"
      },
      {
        "id": "nielsen_percent_audience_share",
        "label": "% audience share",
        "api": "NIELSEN_PERCENT_AUDIENCE_SHARE"
      },
      {
        "id": "nielsen_in_target_percent_audience_share",
        "label": "Nielsen In Target Percent Audience Share",
        "api": "NIELSEN_IN_TARGET_PERCENT_AUDIENCE_SHARE"
      },
      {
        "id": "nielsen_audience_index",
        "label": "Audience index",
        "api": "NIELSEN_AUDIENCE_INDEX"
      },
      {
        "id": "nielsen_in_target_audience_index",
        "label": "Nielsen In Target Audience Index",
        "api": "NIELSEN_IN_TARGET_AUDIENCE_INDEX"
      },
      {
        "id": "nielsen_impressions_index",
        "label": "Impressions index",
        "api": "NIELSEN_IMPRESSIONS_INDEX"
      },
      {
        "id": "nielsen_in_target_impressions_index",
        "label": "Nielsen In Target Impressions Index",
        "api": "NIELSEN_IN_TARGET_IMPRESSIONS_INDEX"
      },
      {
        "id": "nielsen_in_target_ratio",
        "label": "Processed Nielsen in-target rate",
        "api": "NIELSEN_IN_TARGET_RATIO"
      },
      {
        "id": "dp_impressions",
        "label": "Impressions",
        "api": "DP_IMPRESSIONS"
      },
      {
        "id": "dp_clicks",
        "label": "Clicks",
        "api": "DP_CLICKS"
      },
      {
        "id": "dp_queries",
        "label": "Queries",
        "api": "DP_QUERIES"
      },
      {
        "id": "dp_matched_queries",
        "label": "Matched queries",
        "api": "DP_MATCHED_QUERIES"
      },
      {
        "id": "dp_cost",
        "label": "Cost",
        "api": "DP_COST"
      },
      {
        "id": "dp_ecpm",
        "label": "Total Average eCPM",
        "api": "DP_ECPM"
      },
      {
        "id": "partner_management_host_impressions",
        "label": "Host impressions",
        "api": "PARTNER_MANAGEMENT_HOST_IMPRESSIONS"
      },
      {
        "id": "partner_management_host_clicks",
        "label": "Host clicks",
        "api": "PARTNER_MANAGEMENT_HOST_CLICKS"
      },
      {
        "id": "partner_management_host_ctr",
        "label": "Host CTR",
        "api": "PARTNER_MANAGEMENT_HOST_CTR"
      },
      {
        "id": "partner_management_unfilled_impressions",
        "label": "Unfilled impressions",
        "api": "PARTNER_MANAGEMENT_UNFILLED_IMPRESSIONS"
      },
      {
        "id": "partner_management_partner_impressions",
        "label": "Partner impressions",
        "api": "PARTNER_MANAGEMENT_PARTNER_IMPRESSIONS"
      },
      {
        "id": "partner_management_partner_clicks",
        "label": "Partner clicks",
        "api": "PARTNER_MANAGEMENT_PARTNER_CLICKS"
      },
      {
        "id": "partner_management_partner_ctr",
        "label": "Partner CTR",
        "api": "PARTNER_MANAGEMENT_PARTNER_CTR"
      },
      {
        "id": "partner_management_gross_revenue",
        "label": "Gross revenue",
        "api": "PARTNER_MANAGEMENT_GROSS_REVENUE"
      },
      {
        "id": "partner_finance_host_impressions",
        "label": "Host impressions",
        "api": "PARTNER_FINANCE_HOST_IMPRESSIONS"
      },
      {
        "id": "partner_finance_host_revenue",
        "label": "Host revenue",
        "api": "PARTNER_FINANCE_HOST_REVENUE"
      },
      {
        "id": "partner_finance_host_ecpm",
        "label": "Host eCPM",
        "api": "PARTNER_FINANCE_HOST_ECPM"
      },
      {
        "id": "partner_finance_partner_revenue",
        "label": "Partner revenue",
        "api": "PARTNER_FINANCE_PARTNER_REVENUE"
      },
      {
        "id": "partner_finance_partner_ecpm",
        "label": "Partner eCPM",
        "api": "PARTNER_FINANCE_PARTNER_ECPM"
      },
      {
        "id": "partner_finance_gross_revenue",
        "label": "Gross revenue",
        "api": "PARTNER_FINANCE_GROSS_REVENUE"
      },
      {
        "id": "creative_load_time_0_500_ms_percent",
        "label": "Creative load time 0 - 500ms (%)",
        "api": "CREATIVE_LOAD_TIME_0_500_MS_PERCENT"
      },
      {
        "id": "creative_load_time_500_1000_ms_percent",
        "label": "Creative load time 500ms - 1s (%)",
        "api": "CREATIVE_LOAD_TIME_500_1000_MS_PERCENT"
      },
      {
        "id": "creative_load_time_1_2_s_percent",
        "label": "Creative load time 1s - 2s (%)",
        "api": "CREATIVE_LOAD_TIME_1_2_S_PERCENT"
      },
      {
        "id": "creative_load_time_2_4_s_percent",
        "label": "Creative load time 2s - 4s (%)",
        "api": "CREATIVE_LOAD_TIME_2_4_S_PERCENT"
      },
      {
        "id": "creative_load_time_4_8_s_percent",
        "label": "Creative load time 4s - 8s (%)",
        "api": "CREATIVE_LOAD_TIME_4_8_S_PERCENT"
      },
      {
        "id": "creative_load_time_greater_than_8_s_percent",
        "label": "Creative load time >8s (%)",
        "api": "CREATIVE_LOAD_TIME_GREATER_THAN_8_S_PERCENT"
      },
      {
        "id": "unviewed_reason_slot_never_entered_viewport_percent",
        "label": "Slot never entered viewport (%)",
        "api": "UNVIEWED_REASON_SLOT_NEVER_ENTERED_VIEWPORT_PERCENT"
      },
      {
        "id": "unviewed_reason_user_scrolled_before_ad_filled_percent",
        "label": "User scrolled before ad filled (%)",
        "api": "UNVIEWED_REASON_USER_SCROLLED_BEFORE_AD_FILLED_PERCENT"
      },
      {
        "id": "unviewed_reason_user_scrolled_before_ad_loaded_percent",
        "label": "User scrolled/navigated before ad loaded (%)",
        "api": "UNVIEWED_REASON_USER_SCROLLED_BEFORE_AD_LOADED_PERCENT"
      },
      {
        "id": "unviewed_reason_user_scrolled_before_1_s_percent",
        "label": "User scrolled/navigated before 1 second (%)",
        "api": "UNVIEWED_REASON_USER_SCROLLED_BEFORE_1_S_PERCENT"
      },
      {
        "id": "unviewed_reason_other_percent",
        "label": "Other non-viewable impression reasons (%)",
        "api": "UNVIEWED_REASON_OTHER_PERCENT"
      },
      {
        "id": "page_navigation_to_tag_loaded_time_0_500_ms_percent",
        "label": "Page navigation to tag loaded time 0 - 500ms (%)",
        "api": "PAGE_NAVIGATION_TO_TAG_LOADED_TIME_0_500_MS_PERCENT"
      },
      {
        "id": "page_navigation_to_tag_loaded_time_500_1000_ms_percent",
        "label": "Page navigation to tag loaded time 500ms - 1s (%)",
        "api": "PAGE_NAVIGATION_TO_TAG_LOADED_TIME_500_1000_MS_PERCENT"
      },
      {
        "id": "page_navigation_to_tag_loaded_time_1_2_s_percent",
        "label": "Page navigation to tag loaded time 1s - 2s (%)",
        "api": "PAGE_NAVIGATION_TO_TAG_LOADED_TIME_1_2_S_PERCENT"
      },
      {
        "id": "page_navigation_to_tag_loaded_time_2_4_s_percent",
        "label": "Page navigation to tag loaded time 2s - 4s (%)",
        "api": "PAGE_NAVIGATION_TO_TAG_LOADED_TIME_2_4_S_PERCENT"
      },
      {
        "id": "page_navigation_to_tag_loaded_time_4_8_s_percent",
        "label": "Page navigation to tag loaded time 4s - 8s (%)",
        "api": "PAGE_NAVIGATION_TO_TAG_LOADED_TIME_4_8_S_PERCENT"
      },
      {
        "id": "page_navigation_to_tag_loaded_time_greater_than_8_s_percent",
        "label": "Page navigation to tag loaded time >8s (%)",
        "api": "PAGE_NAVIGATION_TO_TAG_LOADED_TIME_GREATER_THAN_8_S_PERCENT"
      },
      {
        "id": "page_navigation_to_first_ad_request_time_0_500_ms_percent",
        "label": "Page navigation to first ad request time 0 - 500ms (%)",
        "api": "PAGE_NAVIGATION_TO_FIRST_AD_REQUEST_TIME_0_500_MS_PERCENT"
      },
      {
        "id": "page_navigation_to_first_ad_request_time_500_1000_ms_percent",
        "label": "Page navigation to first ad request time 500ms - 1s (%)",
        "api": "PAGE_NAVIGATION_TO_FIRST_AD_REQUEST_TIME_500_1000_MS_PERCENT"
      },
      {
        "id": "page_navigation_to_first_ad_request_time_1_2_s_percent",
        "label": "Page navigation to first ad request time 1s - 2s (%)",
        "api": "PAGE_NAVIGATION_TO_FIRST_AD_REQUEST_TIME_1_2_S_PERCENT"
      },
      {
        "id": "page_navigation_to_first_ad_request_time_2_4_s_percent",
        "label": "Page navigation to first ad request time 2s - 4s (%)",
        "api": "PAGE_NAVIGATION_TO_FIRST_AD_REQUEST_TIME_2_4_S_PERCENT"
      },
      {
        "id": "page_navigation_to_first_ad_request_time_4_8_s_percent",
        "label": "Page navigation to first ad request time 4s - 8s (%)",
        "api": "PAGE_NAVIGATION_TO_FIRST_AD_REQUEST_TIME_4_8_S_PERCENT"
      },
      {
        "id": "page_navigation_to_first_ad_request_time_greater_than_8_s_percent",
        "label": "Page navigation to first ad request time >8s (%)",
        "api": "PAGE_NAVIGATION_TO_FIRST_AD_REQUEST_TIME_GREATER_THAN_8_S_PERCENT"
      },
      {
        "id": "tag_load_to_first_ad_request_time_0_500_ms_percent",
        "label": "Tag loaded to first ad request time 0 - 500ms (%)",
        "api": "TAG_LOAD_TO_FIRST_AD_REQUEST_TIME_0_500_MS_PERCENT"
      },
      {
        "id": "tag_load_to_first_ad_request_time_500_1000_ms_percent",
        "label": "Tag loaded to first ad request time 500ms - 1s (%)",
        "api": "TAG_LOAD_TO_FIRST_AD_REQUEST_TIME_500_1000_MS_PERCENT"
      },
      {
        "id": "tag_load_to_first_ad_request_time_1_2_s_percent",
        "label": "Tag loaded to first ad request time 1s - 2s (%)",
        "api": "TAG_LOAD_TO_FIRST_AD_REQUEST_TIME_1_2_S_PERCENT"
      },
      {
        "id": "tag_load_to_first_ad_request_time_2_4_s_percent",
        "label": "Tag loaded to first ad request time 2s - 4s (%)",
        "api": "TAG_LOAD_TO_FIRST_AD_REQUEST_TIME_2_4_S_PERCENT"
      },
      {
        "id": "tag_load_to_first_ad_request_time_4_8_s_percent",
        "label": "Tag loaded to first ad request time 4s - 8s (%)",
        "api": "TAG_LOAD_TO_FIRST_AD_REQUEST_TIME_4_8_S_PERCENT"
      },
      {
        "id": "tag_load_to_first_ad_request_time_greater_than_8_s_percent",
        "label": "Tag loaded to first ad request time >8s (%)",
        "api": "TAG_LOAD_TO_FIRST_AD_REQUEST_TIME_GREATER_THAN_8_S_PERCENT"
      }
    ]
  },
  {
    "id": "total",
    "label": "Total",
    "items": [
      {
        "id": "total_line_item_level_impressions",
        "label": "Total impressions",
        "api": "TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS"
      },
      {
        "id": "total_line_item_level_targeted_impressions",
        "label": "Total targeted impressions",
        "api": "TOTAL_LINE_ITEM_LEVEL_TARGETED_IMPRESSIONS"
      },
      {
        "id": "total_line_item_level_clicks",
        "label": "Total clicks",
        "api": "TOTAL_LINE_ITEM_LEVEL_CLICKS"
      },
      {
        "id": "total_line_item_level_targeted_clicks",
        "label": "Total targeted clicks",
        "api": "TOTAL_LINE_ITEM_LEVEL_TARGETED_CLICKS"
      },
      {
        "id": "total_line_item_level_ctr",
        "label": "Total CTR",
        "api": "TOTAL_LINE_ITEM_LEVEL_CTR"
      },
      {
        "id": "total_line_item_level_cpm_and_cpc_revenue",
        "label": "Total CPM and CPC revenue",
        "api": "TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE"
      },
      {
        "id": "total_line_item_level_all_revenue",
        "label": "Total revenue",
        "api": "TOTAL_LINE_ITEM_LEVEL_ALL_REVENUE"
      },
      {
        "id": "total_line_item_level_without_cpd_average_ecpm",
        "label": "Total average eCPM",
        "api": "TOTAL_LINE_ITEM_LEVEL_WITHOUT_CPD_AVERAGE_ECPM"
      },
      {
        "id": "total_line_item_level_with_cpd_average_ecpm",
        "label": "Total Line Item Level With Cpd Average Ecpm",
        "api": "TOTAL_LINE_ITEM_LEVEL_WITH_CPD_AVERAGE_ECPM"
      },
      {
        "id": "total_code_served_count",
        "label": "Total code served count",
        "api": "TOTAL_CODE_SERVED_COUNT"
      },
      {
        "id": "total_ad_requests",
        "label": "Total ad requests",
        "api": "TOTAL_AD_REQUESTS"
      },
      {
        "id": "total_responses_served",
        "label": "Total responses served",
        "api": "TOTAL_RESPONSES_SERVED"
      },
      {
        "id": "total_unmatched_ad_requests",
        "label": "Total unmatched ad requests",
        "api": "TOTAL_UNMATCHED_AD_REQUESTS"
      },
      {
        "id": "total_fill_rate",
        "label": "Total fill rate",
        "api": "TOTAL_FILL_RATE"
      },
      {
        "id": "total_programmatic_eligible_ad_requests",
        "label": "Programmatic eligible ad requests",
        "api": "TOTAL_PROGRAMMATIC_ELIGIBLE_AD_REQUESTS"
      },
      {
        "id": "total_video_opportunities",
        "label": "True opportunities",
        "api": "TOTAL_VIDEO_OPPORTUNITIES"
      },
      {
        "id": "total_video_capped_opportunities",
        "label": "Capped opportunities",
        "api": "TOTAL_VIDEO_CAPPED_OPPORTUNITIES"
      },
      {
        "id": "total_video_matched_opportunities",
        "label": "Matched opportunities",
        "api": "TOTAL_VIDEO_MATCHED_OPPORTUNITIES"
      },
      {
        "id": "total_video_matched_duration",
        "label": "Matched duration (seconds)",
        "api": "TOTAL_VIDEO_MATCHED_DURATION"
      },
      {
        "id": "total_video_duration",
        "label": "Total duration (seconds)",
        "api": "TOTAL_VIDEO_DURATION"
      },
      {
        "id": "total_video_break_start",
        "label": "Break start",
        "api": "TOTAL_VIDEO_BREAK_START"
      },
      {
        "id": "total_video_break_end",
        "label": "Break end",
        "api": "TOTAL_VIDEO_BREAK_END"
      },
      {
        "id": "total_inventory_level_unfilled_impressions",
        "label": "Unfilled impressions",
        "api": "TOTAL_INVENTORY_LEVEL_UNFILLED_IMPRESSIONS"
      }
    ]
  },
  {
    "id": "adServer",
    "label": "Ad server",
    "items": [
      {
        "id": "ad_server_impressions",
        "label": "Ad server impressions",
        "api": "AD_SERVER_IMPRESSIONS"
      },
      {
        "id": "ad_server_begin_to_render_impressions",
        "label": "Ad server begin to render impressions",
        "api": "AD_SERVER_BEGIN_TO_RENDER_IMPRESSIONS"
      },
      {
        "id": "ad_server_targeted_impressions",
        "label": "Ad server targeted impressions",
        "api": "AD_SERVER_TARGETED_IMPRESSIONS"
      },
      {
        "id": "ad_server_clicks",
        "label": "Ad server clicks",
        "api": "AD_SERVER_CLICKS"
      },
      {
        "id": "ad_server_targeted_clicks",
        "label": "Ad server targeted clicks",
        "api": "AD_SERVER_TARGETED_CLICKS"
      },
      {
        "id": "ad_server_ctr",
        "label": "Ad server CTR",
        "api": "AD_SERVER_CTR"
      },
      {
        "id": "ad_server_cpm_and_cpc_revenue",
        "label": "Ad server CPM and CPC revenue",
        "api": "AD_SERVER_CPM_AND_CPC_REVENUE"
      },
      {
        "id": "ad_server_cpm_and_cpc_revenue_gross",
        "label": "Ad server CPM and CPC revenue (gross)",
        "api": "AD_SERVER_CPM_AND_CPC_REVENUE_GROSS"
      },
      {
        "id": "ad_server_cpd_revenue",
        "label": "Ad server CPD revenue",
        "api": "AD_SERVER_CPD_REVENUE"
      },
      {
        "id": "ad_server_all_revenue",
        "label": "Ad server total revenue",
        "api": "AD_SERVER_ALL_REVENUE"
      },
      {
        "id": "ad_server_all_revenue_gross",
        "label": "Ad server total revenue (gross)",
        "api": "AD_SERVER_ALL_REVENUE_GROSS"
      },
      {
        "id": "ad_server_without_cpd_average_ecpm",
        "label": "Ad server average eCPM",
        "api": "AD_SERVER_WITHOUT_CPD_AVERAGE_ECPM"
      },
      {
        "id": "ad_server_with_cpd_average_ecpm",
        "label": "Ad Server With Cpd Average Ecpm",
        "api": "AD_SERVER_WITH_CPD_AVERAGE_ECPM"
      },
      {
        "id": "ad_server_line_item_level_percent_impressions",
        "label": "Ad server impressions (%)",
        "api": "AD_SERVER_LINE_ITEM_LEVEL_PERCENT_IMPRESSIONS"
      },
      {
        "id": "ad_server_line_item_level_percent_clicks",
        "label": "Ad server clicks (%)",
        "api": "AD_SERVER_LINE_ITEM_LEVEL_PERCENT_CLICKS"
      },
      {
        "id": "ad_server_line_item_level_without_cpd_percent_revenue",
        "label": "Ad server revenue (%)",
        "api": "AD_SERVER_LINE_ITEM_LEVEL_WITHOUT_CPD_PERCENT_REVENUE"
      },
      {
        "id": "ad_server_line_item_level_with_cpd_percent_revenue",
        "label": "Ad Server Line Item Level With Cpd Percent Revenue",
        "api": "AD_SERVER_LINE_ITEM_LEVEL_WITH_CPD_PERCENT_REVENUE"
      },
      {
        "id": "ad_server_unfiltered_impressions",
        "label": "Ad server unfiltered downloaded impressions",
        "api": "AD_SERVER_UNFILTERED_IMPRESSIONS"
      },
      {
        "id": "ad_server_unfiltered_begin_to_render_impressions",
        "label": "Ad server unfiltered begin to render impressions",
        "api": "AD_SERVER_UNFILTERED_BEGIN_TO_RENDER_IMPRESSIONS"
      },
      {
        "id": "ad_server_unfiltered_clicks",
        "label": "Ad server unfiltered clicks",
        "api": "AD_SERVER_UNFILTERED_CLICKS"
      },
      {
        "id": "ad_server_responses_served",
        "label": "Ad server responses served",
        "api": "AD_SERVER_RESPONSES_SERVED"
      }
    ]
  },
  {
    "id": "adsense",
    "label": "AdSense",
    "items": [
      {
        "id": "adsense_line_item_level_impressions",
        "label": "AdSense impressions",
        "api": "ADSENSE_LINE_ITEM_LEVEL_IMPRESSIONS"
      },
      {
        "id": "adsense_line_item_level_targeted_impressions",
        "label": "AdSense targeted impressions",
        "api": "ADSENSE_LINE_ITEM_LEVEL_TARGETED_IMPRESSIONS"
      },
      {
        "id": "adsense_line_item_level_clicks",
        "label": "AdSense clicks",
        "api": "ADSENSE_LINE_ITEM_LEVEL_CLICKS"
      },
      {
        "id": "adsense_line_item_level_targeted_clicks",
        "label": "AdSense targeted clicks",
        "api": "ADSENSE_LINE_ITEM_LEVEL_TARGETED_CLICKS"
      },
      {
        "id": "adsense_line_item_level_ctr",
        "label": "AdSense CTR",
        "api": "ADSENSE_LINE_ITEM_LEVEL_CTR"
      },
      {
        "id": "adsense_line_item_level_revenue",
        "label": "AdSense revenue",
        "api": "ADSENSE_LINE_ITEM_LEVEL_REVENUE"
      },
      {
        "id": "adsense_line_item_level_average_ecpm",
        "label": "AdSense average eCPM",
        "api": "ADSENSE_LINE_ITEM_LEVEL_AVERAGE_ECPM"
      },
      {
        "id": "adsense_line_item_level_percent_impressions",
        "label": "AdSense impressions (%)",
        "api": "ADSENSE_LINE_ITEM_LEVEL_PERCENT_IMPRESSIONS"
      },
      {
        "id": "adsense_line_item_level_percent_clicks",
        "label": "AdSense clicks (%)",
        "api": "ADSENSE_LINE_ITEM_LEVEL_PERCENT_CLICKS"
      },
      {
        "id": "adsense_line_item_level_without_cpd_percent_revenue",
        "label": "AdSense revenue (%)",
        "api": "ADSENSE_LINE_ITEM_LEVEL_WITHOUT_CPD_PERCENT_REVENUE"
      },
      {
        "id": "adsense_line_item_level_with_cpd_percent_revenue",
        "label": "Adsense Line Item Level With Cpd Percent Revenue",
        "api": "ADSENSE_LINE_ITEM_LEVEL_WITH_CPD_PERCENT_REVENUE"
      },
      {
        "id": "adsense_responses_served",
        "label": "AdSense responses served",
        "api": "ADSENSE_RESPONSES_SERVED"
      }
    ]
  },
  {
    "id": "adExchange",
    "label": "Ad Exchange",
    "items": [
      {
        "id": "ad_exchange_line_item_level_impressions",
        "label": "Ad Exchange impressions",
        "api": "AD_EXCHANGE_LINE_ITEM_LEVEL_IMPRESSIONS"
      },
      {
        "id": "ad_exchange_line_item_level_targeted_impressions",
        "label": "Ad Exchange targeted impressions",
        "api": "AD_EXCHANGE_LINE_ITEM_LEVEL_TARGETED_IMPRESSIONS"
      },
      {
        "id": "ad_exchange_line_item_level_clicks",
        "label": "Ad Exchange clicks",
        "api": "AD_EXCHANGE_LINE_ITEM_LEVEL_CLICKS"
      },
      {
        "id": "ad_exchange_line_item_level_targeted_clicks",
        "label": "Ad Exchange targeted clicks",
        "api": "AD_EXCHANGE_LINE_ITEM_LEVEL_TARGETED_CLICKS"
      },
      {
        "id": "ad_exchange_line_item_level_ctr",
        "label": "Ad Exchange CTR",
        "api": "AD_EXCHANGE_LINE_ITEM_LEVEL_CTR"
      },
      {
        "id": "ad_exchange_line_item_level_percent_impressions",
        "label": "Ad Exchange impressions (%)",
        "api": "AD_EXCHANGE_LINE_ITEM_LEVEL_PERCENT_IMPRESSIONS"
      },
      {
        "id": "ad_exchange_line_item_level_percent_clicks",
        "label": "Ad Exchange clicks (%)",
        "api": "AD_EXCHANGE_LINE_ITEM_LEVEL_PERCENT_CLICKS"
      },
      {
        "id": "ad_exchange_line_item_level_revenue",
        "label": "Ad Exchange revenue",
        "api": "AD_EXCHANGE_LINE_ITEM_LEVEL_REVENUE"
      },
      {
        "id": "ad_exchange_line_item_level_without_cpd_percent_revenue",
        "label": "Ad Exchange revenue (%)",
        "api": "AD_EXCHANGE_LINE_ITEM_LEVEL_WITHOUT_CPD_PERCENT_REVENUE"
      },
      {
        "id": "ad_exchange_line_item_level_with_cpd_percent_revenue",
        "label": "Ad Exchange Line Item Level With Cpd Percent Revenue",
        "api": "AD_EXCHANGE_LINE_ITEM_LEVEL_WITH_CPD_PERCENT_REVENUE"
      },
      {
        "id": "ad_exchange_line_item_level_average_ecpm",
        "label": "Ad Exchange average eCPM",
        "api": "AD_EXCHANGE_LINE_ITEM_LEVEL_AVERAGE_ECPM"
      },
      {
        "id": "ad_exchange_responses_served",
        "label": "Ad Exchange responses served",
        "api": "AD_EXCHANGE_RESPONSES_SERVED"
      },
      {
        "id": "ad_exchange_total_requests",
        "label": "Ad Exchange ad requests",
        "api": "AD_EXCHANGE_TOTAL_REQUESTS"
      },
      {
        "id": "ad_exchange_match_rate",
        "label": "Ad Exchange match rate",
        "api": "AD_EXCHANGE_MATCH_RATE"
      },
      {
        "id": "ad_exchange_cost_per_click",
        "label": "Ad Exchange CPC",
        "api": "AD_EXCHANGE_COST_PER_CLICK"
      },
      {
        "id": "ad_exchange_total_request_ctr",
        "label": "Ad Exchange ad request CTR",
        "api": "AD_EXCHANGE_TOTAL_REQUEST_CTR"
      },
      {
        "id": "ad_exchange_matched_request_ctr",
        "label": "Ad Exchange matched request CTR",
        "api": "AD_EXCHANGE_MATCHED_REQUEST_CTR"
      },
      {
        "id": "ad_exchange_total_request_ecpm",
        "label": "Ad Exchange ad request eCPM",
        "api": "AD_EXCHANGE_TOTAL_REQUEST_ECPM"
      },
      {
        "id": "ad_exchange_matched_request_ecpm",
        "label": "Ad Exchange matched request eCPM",
        "api": "AD_EXCHANGE_MATCHED_REQUEST_ECPM"
      },
      {
        "id": "ad_exchange_lift_earnings",
        "label": "Ad Exchange lift",
        "api": "AD_EXCHANGE_LIFT_EARNINGS"
      }
    ]
  },
  {
    "id": "activeView",
    "label": "Active View",
    "items": [
      {
        "id": "total_active_view_viewable_impressions",
        "label": "Total Active View viewable impressions",
        "api": "TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS"
      },
      {
        "id": "total_active_view_measurable_impressions",
        "label": "Total Active View measurable impressions",
        "api": "TOTAL_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS"
      },
      {
        "id": "total_active_view_viewable_impressions_rate",
        "label": "Total Active View Viewable Impressions Rate",
        "api": "TOTAL_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE"
      },
      {
        "id": "total_active_view_eligible_impressions",
        "label": "Total Active View eligible impressions",
        "api": "TOTAL_ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS"
      },
      {
        "id": "total_active_view_measurable_impressions_rate",
        "label": "Total Active View % measurable impressions",
        "api": "TOTAL_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE"
      },
      {
        "id": "total_active_view_average_viewable_time",
        "label": "Total Active View average viewable time (seconds)",
        "api": "TOTAL_ACTIVE_VIEW_AVERAGE_VIEWABLE_TIME"
      },
      {
        "id": "active_view_percent_audible_start_impressions",
        "label": "Active View % audible at start",
        "api": "ACTIVE_VIEW_PERCENT_AUDIBLE_START_IMPRESSIONS"
      },
      {
        "id": "active_view_percent_ever_audible_impressions",
        "label": "Active View % ever audible",
        "api": "ACTIVE_VIEW_PERCENT_EVER_AUDIBLE_IMPRESSIONS"
      },
      {
        "id": "ad_server_active_view_viewable_impressions",
        "label": "Ad server Active View viewable impressions",
        "api": "AD_SERVER_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS"
      },
      {
        "id": "ad_server_active_view_measurable_impressions",
        "label": "Ad server Active View measurable impressions",
        "api": "AD_SERVER_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS"
      },
      {
        "id": "ad_server_active_view_viewable_impressions_rate",
        "label": "Ad server Active View % viewable impressions",
        "api": "AD_SERVER_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE"
      },
      {
        "id": "ad_server_active_view_eligible_impressions",
        "label": "Ad server Active View eligible impressions",
        "api": "AD_SERVER_ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS"
      },
      {
        "id": "ad_server_active_view_measurable_impressions_rate",
        "label": "Ad server Active View % measurable impressions",
        "api": "AD_SERVER_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE"
      },
      {
        "id": "ad_server_active_view_revenue",
        "label": "Ad server Active View revenue",
        "api": "AD_SERVER_ACTIVE_VIEW_REVENUE"
      },
      {
        "id": "ad_server_active_view_average_viewable_time",
        "label": "Ad server Active View average viewable time (seconds)",
        "api": "AD_SERVER_ACTIVE_VIEW_AVERAGE_VIEWABLE_TIME"
      },
      {
        "id": "adsense_active_view_viewable_impressions",
        "label": "AdSense Active View viewable impressions",
        "api": "ADSENSE_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS"
      },
      {
        "id": "adsense_active_view_measurable_impressions",
        "label": "AdSense Active View measurable impressions",
        "api": "ADSENSE_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS"
      },
      {
        "id": "adsense_active_view_viewable_impressions_rate",
        "label": "AdSense Active View % viewable impressions",
        "api": "ADSENSE_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE"
      },
      {
        "id": "adsense_active_view_eligible_impressions",
        "label": "AdSense Active View eligible impressions",
        "api": "ADSENSE_ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS"
      },
      {
        "id": "adsense_active_view_measurable_impressions_rate",
        "label": "AdSense Active View % measurable impressions",
        "api": "ADSENSE_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE"
      },
      {
        "id": "adsense_active_view_average_viewable_time",
        "label": "AdSense Active View average viewable time (seconds)",
        "api": "ADSENSE_ACTIVE_VIEW_AVERAGE_VIEWABLE_TIME"
      },
      {
        "id": "ad_exchange_active_view_viewable_impressions",
        "label": "Ad Exchange Active View viewable impressions",
        "api": "AD_EXCHANGE_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS"
      },
      {
        "id": "ad_exchange_active_view_measurable_impressions",
        "label": "Ad Exchange Active View measurable impressions",
        "api": "AD_EXCHANGE_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS"
      },
      {
        "id": "ad_exchange_active_view_viewable_impressions_rate",
        "label": "Ad Exchange Active View % viewable impressions",
        "api": "AD_EXCHANGE_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE"
      },
      {
        "id": "ad_exchange_active_view_eligible_impressions",
        "label": "Ad Exchange Active View eligible impressions",
        "api": "AD_EXCHANGE_ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS"
      },
      {
        "id": "ad_exchange_active_view_measurable_impressions_rate",
        "label": "Ad Exchange Active View % measurable impressions",
        "api": "AD_EXCHANGE_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE"
      },
      {
        "id": "ad_exchange_active_view_average_viewable_time",
        "label": "Ad Exchange Active View average viewable time (seconds)",
        "api": "AD_EXCHANGE_ACTIVE_VIEW_AVERAGE_VIEWABLE_TIME"
      },
      {
        "id": "total_active_view_revenue",
        "label": "Total Active View revenue",
        "api": "TOTAL_ACTIVE_VIEW_REVENUE"
      },
      {
        "id": "dp_active_view_eligible_impressions",
        "label": "Total Active View eligible impressions",
        "api": "DP_ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS"
      },
      {
        "id": "dp_active_view_measurable_impressions",
        "label": "Total Active View measurable impressions",
        "api": "DP_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS"
      },
      {
        "id": "dp_active_view_viewable_impressions",
        "label": "Total Active View viewable impressions",
        "api": "DP_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS"
      },
      {
        "id": "dp_active_view_measurable_impressions_rate",
        "label": "Total Active View % measurable impressions",
        "api": "DP_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE"
      },
      {
        "id": "dp_active_view_viewable_impressions_rate",
        "label": "Total Active View % viewable impressions",
        "api": "DP_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE"
      }
    ]
  },
  {
    "id": "reachForecast",
    "label": "Reach & forecast",
    "items": [
      {
        "id": "unique_reach_frequency",
        "label": "Average impressions/unique visitor",
        "api": "UNIQUE_REACH_FREQUENCY"
      },
      {
        "id": "unique_reach_impressions",
        "label": "Total reach impressions",
        "api": "UNIQUE_REACH_IMPRESSIONS"
      },
      {
        "id": "unique_reach",
        "label": "Total unique visitors",
        "api": "UNIQUE_REACH"
      },
      {
        "id": "sell_through_forecasted_impressions",
        "label": "Forecasted impressions",
        "api": "SELL_THROUGH_FORECASTED_IMPRESSIONS"
      },
      {
        "id": "partner_sales_partner_impressions",
        "label": "Partner-sold impressions",
        "api": "PARTNER_SALES_PARTNER_IMPRESSIONS"
      },
      {
        "id": "partner_sales_partner_code_served",
        "label": "Partner-sold code served count",
        "api": "PARTNER_SALES_PARTNER_CODE_SERVED"
      },
      {
        "id": "partner_sales_google_impressions",
        "label": "Google-sold impressions",
        "api": "PARTNER_SALES_GOOGLE_IMPRESSIONS"
      },
      {
        "id": "partner_sales_google_reservation_impressions",
        "label": "Google-sold reservation impressions",
        "api": "PARTNER_SALES_GOOGLE_RESERVATION_IMPRESSIONS"
      },
      {
        "id": "partner_sales_google_auction_impressions",
        "label": "Google-sold auction impressions",
        "api": "PARTNER_SALES_GOOGLE_AUCTION_IMPRESSIONS"
      },
      {
        "id": "partner_sales_queries",
        "label": "Total ad requests",
        "api": "PARTNER_SALES_QUERIES"
      },
      {
        "id": "partner_sales_filled_queries",
        "label": "Filled ad requests",
        "api": "PARTNER_SALES_FILLED_QUERIES"
      },
      {
        "id": "partner_sales_sell_through_rate",
        "label": "Fill rate",
        "api": "PARTNER_SALES_SELL_THROUGH_RATE"
      },
      {
        "id": "sell_through_available_impressions",
        "label": "Available impressions",
        "api": "SELL_THROUGH_AVAILABLE_IMPRESSIONS"
      },
      {
        "id": "sell_through_reserved_impressions",
        "label": "Reserved impressions",
        "api": "SELL_THROUGH_RESERVED_IMPRESSIONS"
      },
      {
        "id": "sell_through_sell_through_rate",
        "label": "Sell-through rate",
        "api": "SELL_THROUGH_SELL_THROUGH_RATE"
      }
    ]
  },
  {
    "id": "sdkMediation",
    "label": "SDK mediation",
    "items": [
      {
        "id": "sdk_mediation_creative_impressions",
        "label": "SDK mediation creative impressions",
        "api": "SDK_MEDIATION_CREATIVE_IMPRESSIONS"
      },
      {
        "id": "sdk_mediation_creative_clicks",
        "label": "SDK mediation creative clicks",
        "api": "SDK_MEDIATION_CREATIVE_CLICKS"
      }
    ]
  }
];

export const GAM_CATALOG_STATS = { dimensions: 180, metrics: 364 };
