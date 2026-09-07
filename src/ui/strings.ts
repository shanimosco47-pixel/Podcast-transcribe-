import type { PipelineOutcome } from "../pipeline.js";

type FailureReason = Extract<PipelineOutcome, { status: "failed" }>["reason"];

/**
 * Hebrew, user-facing. Every message names what happened and what to do next;
 * technical detail stays out of the main flow and lives behind a disclosure.
 */
export const HE = {
  appTitle: "תמלול פודקאסטים",
  tagline: "הדביקו קישור לפרק בספוטיפיי וקבלו תמלול וסיכום בעברית.",
  urlLabel: "קישור לפרק בספוטיפיי",
  urlPlaceholder: "https://open.spotify.com/episode/...",
  submit: "צרו תמלול",
  identified: "זיהינו את הפרק",
  show: "התוכנית",
  episode: "הפרק",
  published: "תאריך פרסום",
  duration: "אורך",
  confidence: "ודאות הזיהוי",
  sourceFeed: "תמלול רשמי שפורסם בפיד",
  sourceTranscribed: "תומלל מהאודיו",
  summary: "סיכום",
  keyPoints: "נקודות עיקריות",
  transcript: "התמלול המלא",
  copy: "העתקת התמלול",
  copied: "הועתק",
  download: "הורדת התמלול",
  again: "פרק נוסף",
  technical: "פרטים טכניים",
  ambiguousTitle: "לא הצלחנו לזהות את הפרק בוודאות",
  ambiguousBody: "מצאנו כמה פרקים דומים. בחרו את הפרק הנכון כדי להמשיך.",
  ambiguousConfirm: "אישור הבחירה",
  errorTitle: "לא הצלחנו להמשיך",
  retry: "נסו קישור אחר",
  working: "עובדים על זה",
  workingBody: "התמלול יכול לקחת כמה דקות. הדף מתרענן לבד.",
  phaseQueued: "ממתין בתור",
  phaseResolving: "מזהים את הפרק",
  phaseDownloading: "מורידים את האודיו",
  phaseTranscribing: "מתמללים",
  phaseSummarizing: "מסכמים",
  queuePosition: "מקום בתור",
  chunkProgress: "קטע",

  loginTitle: "כניסה",
  loginBody: "האפליקציה פרטית. הזינו את קוד הגישה כדי להמשיך.",
  loginLabel: "קוד גישה",
  loginSubmit: "כניסה",
  loginFailed: "קוד הגישה שגוי.",
  logout: "יציאה",
  loginLocked: "יותר מדי ניסיונות כניסה. נסו שוב בעוד",
  loginLockedUnit: "שניות.",

  setupTitle: "האפליקציה אינה מוגדרת",
  setupBody:
    "כדי להפעיל את השירות יש להגדיר את משתני הסביבה הבאים ולהפעיל מחדש. הערכים עצמם אינם מוצגים כאן ואינם נשמרים בקוד.",
  setupAuthNote: "ללא קוד גישה האפליקציה חוסמת כל שימוש, כדי שלא תהיה פתוחה לכל אחד.",
} as const;

/** One Hebrew sentence per failure, plus what the person can do about it. */
export function failureMessage(reason: FailureReason): string {
  switch (reason) {
    case "empty":
      return "לא הוזן קישור. הדביקו קישור לפרק בספוטיפיי.";
    case "not_a_url":
      return "הכתובת שהוזנה אינה קישור תקין.";
    case "not_spotify":
      return "הקישור אינו מוביל לספוטיפיי. הדביקו קישור לפרק מתוך ספוטיפיי.";
    case "not_an_episode":
      return "הקישור מוביל לתוכנית או לרשימה, ולא לפרק מסוים. פתחו את הפרק והעתיקו את הקישור שלו.";
    case "malformed_episode_id":
      return "מזהה הפרק בקישור אינו תקין. העתיקו שוב את הקישור מספוטיפיי.";
    case "embed_unavailable":
      return "ספוטיפיי לא הגיב כרגע. נסו שוב בעוד כמה דקות.";
    case "embed_unparsable":
      return "לא הצלחנו לקרוא את פרטי הפרק מספוטיפיי.";
    case "feed_not_found":
      return "לא מצאנו פיד ציבורי לתוכנית הזו, ולכן אי אפשר להוריד את הפרק כחוק.";
    case "show_mismatch":
      return "מצאנו תוכנית בשם דומה אך לא זהה, ולכן עצרנו כדי לא לתמלל פרק מתוכנית אחרת.";
    case "feed_unavailable":
      return "הפיד של התוכנית אינו זמין כרגע. נסו שוב מאוחר יותר.";
    case "blocked_url":
      return "הקישור שהתקבל אינו מורשה מטעמי אבטחה, ולכן לא פנינו אליו.";
    case "no_match":
      return "לא מצאנו את הפרק הזה בפיד הציבורי של התוכנית.";
    case "no_audio":
      return "לפרק הזה אין קובץ אודיו ציבורי ואין תמלול מוכן.";
    case "transcript_unavailable":
      return "לא הצלחנו להשיג את התמלול של הפרק. נסו שוב מאוחר יותר.";
    case "queue_full":
      return "יש כרגע יותר מדי בקשות בתור. נסו שוב בעוד כמה דקות.";
    case "not_configured":
      return "שירות התמלול או הסיכום אינו מוגדר. יש להשלים את ההגדרות ולהפעיל מחדש.";
    case "provider_failed":
      return "ספק התמלול או הסיכום החזיר שגיאה. נסו שוב מאוחר יותר.";
    default:
      return "אירעה תקלה בלתי צפויה.";
  }
}
