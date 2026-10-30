/** Estimation units only: calibrate against actual usage, never call this token count. */
export const METER_VERSION='wire-model-fields-utf8-units/v1';
const COVERAGE=new Set(['historical-complete-envelope','complete-continuation-envelope','complete-summary-envelope','complete-new-envelope-excluding-summary']);
function hasImage(value){if(!value||typeof value!=='object')return false;if(['image','image_url','document'].includes(value.type))return true;return Object.values(value).some(v=>typeof v==='object'&&hasImage(v));}
export function measureEnvelope(body,coverage){
 if(!COVERAGE.has(coverage)||!body||!Array.isArray(body.messages))throw Error('COMPLETE_ENVELOPE_REQUIRED');
 const {dsh_session_log,dsh_plugin_packages,...fields}=body;
 if(hasImage(fields))return {available:false,value:null,meter_version:METER_VERSION,coverage,reason:'MULTIMODAL_REQUIRES_SEPARATE_CALIBRATION'};
 // Official rc.4 states these extensions are outside model input. All other fields
 // remain in these calibration units; they are not claimed to equal server tokens.
 return {available:true,kind:'empirical_calibration_units_not_tokens',value:Buffer.byteLength(JSON.stringify(fields),'utf8'),
  meter_version:METER_VERSION,coverage,token_count:null,guaranteed_bound:false};
}
