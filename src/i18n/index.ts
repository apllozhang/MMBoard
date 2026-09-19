import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { zh } from "./zh";
import { en } from "./en";

const LANG_KEY = "lang";

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: localStorage.getItem(LANG_KEY) || "zh",
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
});

i18n.on("languageChanged", (lng) => {
  localStorage.setItem(LANG_KEY, lng);
  document.documentElement.lang = lng === "zh" ? "zh-CN" : lng;
});

export default i18n;
