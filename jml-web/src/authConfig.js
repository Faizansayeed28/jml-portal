export const msalConfig = {
  auth: {
    clientId: "398da3f6-ebcc-4c73-bd41-bd66609acc37",
    authority: "https://login.microsoftonline.com/7a2369dd-7d9f-421a-866f-c114c486150a",
    redirectUri: "http://localhost:5173",
  },
  cache: { cacheLocation: "sessionStorage" },
};

export const apiScopes = ["api://1e573b37-504d-4a18-8af8-5fca18cbc929/access_as_user"];

export const API_URL = "http://localhost:5175";