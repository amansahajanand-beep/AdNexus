const assert = require('assert');
const { normalizeSite, extractJsonParams } = require('../src/services/firebaseRemoteConfigService');

assert.strictEqual(normalizeSite('Finance2.Example.com'), 'finance2.example.com');
assert.strictEqual(normalizeSite('www.a.b.com'), 'a.b.com');

const out = extractJsonParams({
  parameters: {
    ads_config: {
      defaultValue: { value: '{"link":"https://x.finance2.com/run"}' },
      conditionalValues: { india: { value: '[1,2]' }, broken: { value: '{oops' } },
    },
    plain: { defaultValue: { value: 'hello' } },
    num: { defaultValue: { value: '42' } },
  },
});
assert.deepStrictEqual(out, [
  { key: 'ads_config', source: 'default', json: { link: 'https://x.finance2.com/run' } },
  { key: 'ads_config', source: 'india', json: [1, 2] },
]);
const { extractHosts } = require('../src/services/firebaseRemoteConfigService');
const hosts = [...extractHosts({
  link: 'https://www.finance2.example.com/run?x=1',
  nested: [{ u: 'quiz1.example.com' }, 'not a host', 42],
  text: 'open http://a.example.org/p and https://b.example.org',
})].sort();
assert.deepStrictEqual(hosts, ['a.example.org', 'b.example.org', 'finance2.example.com', 'quiz1.example.com']);
console.log('firebase remote config extraction: OK');

const { extractHostEntries, isLinkPath } = require('../src/services/firebaseRemoteConfigService');
const sample = {
  normal_user: {
    App_PrivacyPolicy: 'https://sites.google.com/view/x/home',
    screen: {
      QuizAdsDesign: { Quiz_App_Icon: ['https://videocall.blr1.digitaloceanspaces.com/a.jpg'] },
      AppProxyStructure: {
        App_Proxy_Ip_Checker_Url: 'https://pro.ip-api.com/json/?key=k',
        Quiz_Link_List: ['game4.brainfungames.com'],
        Quiz_Link_List_Exclude: ['game4.brainfungames.com'],
      },
    },
  },
};
const linkHosts = extractHostEntries(sample).filter((e) => isLinkPath(e.path) && !/exclude/i.test(e.path));
assert.deepStrictEqual(linkHosts.map((e) => e.host), ['game4.brainfungames.com']);
assert.strictEqual(linkHosts[0].path, 'normal_user.screen.AppProxyStructure.Quiz_Link_List[0]');
console.log('link-path detection: OK');

const { latestVersionParam } = require('../src/services/firebaseRemoteConfigService');
assert.strictEqual(latestVersionParam([
  { key: 'appVersionName_0' }, { key: 'appVersionName_1_10' }, { key: 'appVersionName_1_4' }, { key: 'appVersionName_1_0' },
]), 'appVersionName_1_10');
assert.strictEqual(latestVersionParam([{ key: 'other' }]), null);
console.log('latest version param: OK');
