var EcoflowFleetCard=function(t){"use strict";function e(t,e,s,i){var o,n=arguments.length,r=n<3?e:null===i?i=Object.getOwnPropertyDescriptor(e,s):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)r=Reflect.decorate(t,e,s,i);else for(var a=t.length-1;a>=0;a--)(o=t[a])&&(r=(n<3?o(r):n>3?o(e,s,r):o(e,s))||r);return n>3&&r&&Object.defineProperty(e,s,r),r}"function"==typeof SuppressedError&&SuppressedError;
/**
     * @license
     * Copyright 2019 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const s=globalThis,i=s.ShadowRoot&&(void 0===s.ShadyCSS||s.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,o=Symbol(),n=new WeakMap;let r=class{constructor(t,e,s){if(this._$cssResult$=!0,s!==o)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=t,this.t=e}get styleSheet(){let t=this.o;const e=this.t;if(i&&void 0===t){const s=void 0!==e&&1===e.length;s&&(t=n.get(e)),void 0===t&&((this.o=t=new CSSStyleSheet).replaceSync(this.cssText),s&&n.set(e,t))}return t}toString(){return this.cssText}};const a=(t,...e)=>{const s=1===t.length?t[0]:e.reduce((e,s,i)=>e+(t=>{if(!0===t._$cssResult$)return t.cssText;if("number"==typeof t)return t;throw Error("Value passed to 'css' function must be a 'css' function result: "+t+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(s)+t[i+1],t[0]);return new r(s,t,o)},l=i?t=>t:t=>t instanceof CSSStyleSheet?(t=>{let e="";for(const s of t.cssRules)e+=s.cssText;return(t=>new r("string"==typeof t?t:t+"",void 0,o))(e)})(t):t,{is:h,defineProperty:c,getOwnPropertyDescriptor:d,getOwnPropertyNames:p,getOwnPropertySymbols:u,getPrototypeOf:f}=Object,$=globalThis,_=$.trustedTypes,g=_?_.emptyScript:"",y=$.reactiveElementPolyfillSupport,m=(t,e)=>t,v={toAttribute(t,e){switch(e){case Boolean:t=t?g:null;break;case Object:case Array:t=null==t?t:JSON.stringify(t)}return t},fromAttribute(t,e){let s=t;switch(e){case Boolean:s=null!==t;break;case Number:s=null===t?null:Number(t);break;case Object:case Array:try{s=JSON.parse(t)}catch(t){s=null}}return s}},A=(t,e)=>!h(t,e),b={attribute:!0,type:String,converter:v,reflect:!1,useDefault:!1,hasChanged:A};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */Symbol.metadata??=Symbol("metadata"),$.litPropertyMetadata??=new WeakMap;let w=class extends HTMLElement{static addInitializer(t){this._$Ei(),(this.l??=[]).push(t)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(t,e=b){if(e.state&&(e.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(t)&&((e=Object.create(e)).wrapped=!0),this.elementProperties.set(t,e),!e.noAccessor){const s=Symbol(),i=this.getPropertyDescriptor(t,s,e);void 0!==i&&c(this.prototype,t,i)}}static getPropertyDescriptor(t,e,s){const{get:i,set:o}=d(this.prototype,t)??{get(){return this[e]},set(t){this[e]=t}};return{get:i,set(e){const n=i?.call(this);o?.call(this,e),this.requestUpdate(t,n,s)},configurable:!0,enumerable:!0}}static getPropertyOptions(t){return this.elementProperties.get(t)??b}static _$Ei(){if(this.hasOwnProperty(m("elementProperties")))return;const t=f(this);t.finalize(),void 0!==t.l&&(this.l=[...t.l]),this.elementProperties=new Map(t.elementProperties)}static finalize(){if(this.hasOwnProperty(m("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(m("properties"))){const t=this.properties,e=[...p(t),...u(t)];for(const s of e)this.createProperty(s,t[s])}const t=this[Symbol.metadata];if(null!==t){const e=litPropertyMetadata.get(t);if(void 0!==e)for(const[t,s]of e)this.elementProperties.set(t,s)}this._$Eh=new Map;for(const[t,e]of this.elementProperties){const s=this._$Eu(t,e);void 0!==s&&this._$Eh.set(s,t)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(t){const e=[];if(Array.isArray(t)){const s=new Set(t.flat(1/0).reverse());for(const t of s)e.unshift(l(t))}else void 0!==t&&e.push(l(t));return e}static _$Eu(t,e){const s=e.attribute;return!1===s?void 0:"string"==typeof s?s:"string"==typeof t?t.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(t=>this.enableUpdating=t),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(t=>t(this))}addController(t){(this._$EO??=new Set).add(t),void 0!==this.renderRoot&&this.isConnected&&t.hostConnected?.()}removeController(t){this._$EO?.delete(t)}_$E_(){const t=new Map,e=this.constructor.elementProperties;for(const s of e.keys())this.hasOwnProperty(s)&&(t.set(s,this[s]),delete this[s]);t.size>0&&(this._$Ep=t)}createRenderRoot(){const t=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return((t,e)=>{if(i)t.adoptedStyleSheets=e.map(t=>t instanceof CSSStyleSheet?t:t.styleSheet);else for(const i of e){const e=document.createElement("style"),o=s.litNonce;void 0!==o&&e.setAttribute("nonce",o),e.textContent=i.cssText,t.appendChild(e)}})(t,this.constructor.elementStyles),t}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(t=>t.hostConnected?.())}enableUpdating(t){}disconnectedCallback(){this._$EO?.forEach(t=>t.hostDisconnected?.())}attributeChangedCallback(t,e,s){this._$AK(t,s)}_$ET(t,e){const s=this.constructor.elementProperties.get(t),i=this.constructor._$Eu(t,s);if(void 0!==i&&!0===s.reflect){const o=(void 0!==s.converter?.toAttribute?s.converter:v).toAttribute(e,s.type);this._$Em=t,null==o?this.removeAttribute(i):this.setAttribute(i,o),this._$Em=null}}_$AK(t,e){const s=this.constructor,i=s._$Eh.get(t);if(void 0!==i&&this._$Em!==i){const t=s.getPropertyOptions(i),o="function"==typeof t.converter?{fromAttribute:t.converter}:void 0!==t.converter?.fromAttribute?t.converter:v;this._$Em=i;const n=o.fromAttribute(e,t.type);this[i]=n??this._$Ej?.get(i)??n,this._$Em=null}}requestUpdate(t,e,s,i=!1,o){if(void 0!==t){const n=this.constructor;if(!1===i&&(o=this[t]),s??=n.getPropertyOptions(t),!((s.hasChanged??A)(o,e)||s.useDefault&&s.reflect&&o===this._$Ej?.get(t)&&!this.hasAttribute(n._$Eu(t,s))))return;this.C(t,e,s)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(t,e,{useDefault:s,reflect:i,wrapped:o},n){s&&!(this._$Ej??=new Map).has(t)&&(this._$Ej.set(t,n??e??this[t]),!0!==o||void 0!==n)||(this._$AL.has(t)||(this.hasUpdated||s||(e=void 0),this._$AL.set(t,e)),!0===i&&this._$Em!==t&&(this._$Eq??=new Set).add(t))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(t){Promise.reject(t)}const t=this.scheduleUpdate();return null!=t&&await t,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[t,e]of this._$Ep)this[t]=e;this._$Ep=void 0}const t=this.constructor.elementProperties;if(t.size>0)for(const[e,s]of t){const{wrapped:t}=s,i=this[e];!0!==t||this._$AL.has(e)||void 0===i||this.C(e,void 0,s,i)}}let t=!1;const e=this._$AL;try{t=this.shouldUpdate(e),t?(this.willUpdate(e),this._$EO?.forEach(t=>t.hostUpdate?.()),this.update(e)):this._$EM()}catch(e){throw t=!1,this._$EM(),e}t&&this._$AE(e)}willUpdate(t){}_$AE(t){this._$EO?.forEach(t=>t.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(t)),this.updated(t)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(t){return!0}update(t){this._$Eq&&=this._$Eq.forEach(t=>this._$ET(t,this[t])),this._$EM()}updated(t){}firstUpdated(t){}};w.elementStyles=[],w.shadowRootOptions={mode:"open"},w[m("elementProperties")]=new Map,w[m("finalized")]=new Map,y?.({ReactiveElement:w}),($.reactiveElementVersions??=[]).push("2.1.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const E=globalThis,S=t=>t,C=E.trustedTypes,x=C?C.createPolicy("lit-html",{createHTML:t=>t}):void 0,P="$lit$",O=`lit$${Math.random().toFixed(9).slice(2)}$`,U="?"+O,T=`<${U}>`,H=document,M=()=>H.createComment(""),k=t=>null===t||"object"!=typeof t&&"function"!=typeof t,R=Array.isArray,N="[ \t\n\f\r]",z=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,j=/-->/g,D=/>/g,L=RegExp(`>|${N}(?:([^\\s"'>=/]+)(${N}*=${N}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,"g"),I=/'/g,B=/"/g,F=/^(?:script|style|textarea|title)$/i,W=(t=>(e,...s)=>({_$litType$:t,strings:e,values:s}))(1),q=Symbol.for("lit-noChange"),V=Symbol.for("lit-nothing"),J=new WeakMap,K=H.createTreeWalker(H,129);function Z(t,e){if(!R(t)||!t.hasOwnProperty("raw"))throw Error("invalid template strings array");return void 0!==x?x.createHTML(e):e}const G=(t,e)=>{const s=t.length-1,i=[];let o,n=2===e?"<svg>":3===e?"<math>":"",r=z;for(let e=0;e<s;e++){const s=t[e];let a,l,h=-1,c=0;for(;c<s.length&&(r.lastIndex=c,l=r.exec(s),null!==l);)c=r.lastIndex,r===z?"!--"===l[1]?r=j:void 0!==l[1]?r=D:void 0!==l[2]?(F.test(l[2])&&(o=RegExp("</"+l[2],"g")),r=L):void 0!==l[3]&&(r=L):r===L?">"===l[0]?(r=o??z,h=-1):void 0===l[1]?h=-2:(h=r.lastIndex-l[2].length,a=l[1],r=void 0===l[3]?L:'"'===l[3]?B:I):r===B||r===I?r=L:r===j||r===D?r=z:(r=L,o=void 0);const d=r===L&&t[e+1].startsWith("/>")?" ":"";n+=r===z?s+T:h>=0?(i.push(a),s.slice(0,h)+P+s.slice(h)+O+d):s+O+(-2===h?e:d)}return[Z(t,n+(t[s]||"<?>")+(2===e?"</svg>":3===e?"</math>":"")),i]};class X{constructor({strings:t,_$litType$:e},s){let i;this.parts=[];let o=0,n=0;const r=t.length-1,a=this.parts,[l,h]=G(t,e);if(this.el=X.createElement(l,s),K.currentNode=this.el.content,2===e||3===e){const t=this.el.content.firstChild;t.replaceWith(...t.childNodes)}for(;null!==(i=K.nextNode())&&a.length<r;){if(1===i.nodeType){if(i.hasAttributes())for(const t of i.getAttributeNames())if(t.endsWith(P)){const e=h[n++],s=i.getAttribute(t).split(O),r=/([.?@])?(.*)/.exec(e);a.push({type:1,index:o,name:r[2],strings:s,ctor:"."===r[1]?st:"?"===r[1]?it:"@"===r[1]?ot:et}),i.removeAttribute(t)}else t.startsWith(O)&&(a.push({type:6,index:o}),i.removeAttribute(t));if(F.test(i.tagName)){const t=i.textContent.split(O),e=t.length-1;if(e>0){i.textContent=C?C.emptyScript:"";for(let s=0;s<e;s++)i.append(t[s],M()),K.nextNode(),a.push({type:2,index:++o});i.append(t[e],M())}}}else if(8===i.nodeType)if(i.data===U)a.push({type:2,index:o});else{let t=-1;for(;-1!==(t=i.data.indexOf(O,t+1));)a.push({type:7,index:o}),t+=O.length-1}o++}}static createElement(t,e){const s=H.createElement("template");return s.innerHTML=t,s}}function Q(t,e,s=t,i){if(e===q)return e;let o=void 0!==i?s._$Co?.[i]:s._$Cl;const n=k(e)?void 0:e._$litDirective$;return o?.constructor!==n&&(o?._$AO?.(!1),void 0===n?o=void 0:(o=new n(t),o._$AT(t,s,i)),void 0!==i?(s._$Co??=[])[i]=o:s._$Cl=o),void 0!==o&&(e=Q(t,o._$AS(t,e.values),o,i)),e}class Y{constructor(t,e){this._$AV=[],this._$AN=void 0,this._$AD=t,this._$AM=e}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(t){const{el:{content:e},parts:s}=this._$AD,i=(t?.creationScope??H).importNode(e,!0);K.currentNode=i;let o=K.nextNode(),n=0,r=0,a=s[0];for(;void 0!==a;){if(n===a.index){let e;2===a.type?e=new tt(o,o.nextSibling,this,t):1===a.type?e=new a.ctor(o,a.name,a.strings,this,t):6===a.type&&(e=new nt(o,this,t)),this._$AV.push(e),a=s[++r]}n!==a?.index&&(o=K.nextNode(),n++)}return K.currentNode=H,i}p(t){let e=0;for(const s of this._$AV)void 0!==s&&(void 0!==s.strings?(s._$AI(t,s,e),e+=s.strings.length-2):s._$AI(t[e])),e++}}class tt{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(t,e,s,i){this.type=2,this._$AH=V,this._$AN=void 0,this._$AA=t,this._$AB=e,this._$AM=s,this.options=i,this._$Cv=i?.isConnected??!0}get parentNode(){let t=this._$AA.parentNode;const e=this._$AM;return void 0!==e&&11===t?.nodeType&&(t=e.parentNode),t}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(t,e=this){t=Q(this,t,e),k(t)?t===V||null==t||""===t?(this._$AH!==V&&this._$AR(),this._$AH=V):t!==this._$AH&&t!==q&&this._(t):void 0!==t._$litType$?this.$(t):void 0!==t.nodeType?this.T(t):(t=>R(t)||"function"==typeof t?.[Symbol.iterator])(t)?this.k(t):this._(t)}O(t){return this._$AA.parentNode.insertBefore(t,this._$AB)}T(t){this._$AH!==t&&(this._$AR(),this._$AH=this.O(t))}_(t){this._$AH!==V&&k(this._$AH)?this._$AA.nextSibling.data=t:this.T(H.createTextNode(t)),this._$AH=t}$(t){const{values:e,_$litType$:s}=t,i="number"==typeof s?this._$AC(t):(void 0===s.el&&(s.el=X.createElement(Z(s.h,s.h[0]),this.options)),s);if(this._$AH?._$AD===i)this._$AH.p(e);else{const t=new Y(i,this),s=t.u(this.options);t.p(e),this.T(s),this._$AH=t}}_$AC(t){let e=J.get(t.strings);return void 0===e&&J.set(t.strings,e=new X(t)),e}k(t){R(this._$AH)||(this._$AH=[],this._$AR());const e=this._$AH;let s,i=0;for(const o of t)i===e.length?e.push(s=new tt(this.O(M()),this.O(M()),this,this.options)):s=e[i],s._$AI(o),i++;i<e.length&&(this._$AR(s&&s._$AB.nextSibling,i),e.length=i)}_$AR(t=this._$AA.nextSibling,e){for(this._$AP?.(!1,!0,e);t!==this._$AB;){const e=S(t).nextSibling;S(t).remove(),t=e}}setConnected(t){void 0===this._$AM&&(this._$Cv=t,this._$AP?.(t))}}class et{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(t,e,s,i,o){this.type=1,this._$AH=V,this._$AN=void 0,this.element=t,this.name=e,this._$AM=i,this.options=o,s.length>2||""!==s[0]||""!==s[1]?(this._$AH=Array(s.length-1).fill(new String),this.strings=s):this._$AH=V}_$AI(t,e=this,s,i){const o=this.strings;let n=!1;if(void 0===o)t=Q(this,t,e,0),n=!k(t)||t!==this._$AH&&t!==q,n&&(this._$AH=t);else{const i=t;let r,a;for(t=o[0],r=0;r<o.length-1;r++)a=Q(this,i[s+r],e,r),a===q&&(a=this._$AH[r]),n||=!k(a)||a!==this._$AH[r],a===V?t=V:t!==V&&(t+=(a??"")+o[r+1]),this._$AH[r]=a}n&&!i&&this.j(t)}j(t){t===V?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,t??"")}}class st extends et{constructor(){super(...arguments),this.type=3}j(t){this.element[this.name]=t===V?void 0:t}}class it extends et{constructor(){super(...arguments),this.type=4}j(t){this.element.toggleAttribute(this.name,!!t&&t!==V)}}class ot extends et{constructor(t,e,s,i,o){super(t,e,s,i,o),this.type=5}_$AI(t,e=this){if((t=Q(this,t,e,0)??V)===q)return;const s=this._$AH,i=t===V&&s!==V||t.capture!==s.capture||t.once!==s.once||t.passive!==s.passive,o=t!==V&&(s===V||i);i&&this.element.removeEventListener(this.name,this,s),o&&this.element.addEventListener(this.name,this,t),this._$AH=t}handleEvent(t){"function"==typeof this._$AH?this._$AH.call(this.options?.host??this.element,t):this._$AH.handleEvent(t)}}class nt{constructor(t,e,s){this.element=t,this.type=6,this._$AN=void 0,this._$AM=e,this.options=s}get _$AU(){return this._$AM._$AU}_$AI(t){Q(this,t)}}const rt=E.litHtmlPolyfillSupport;rt?.(X,tt),(E.litHtmlVersions??=[]).push("3.3.3");const at=globalThis;
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */class lt extends w{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const t=super.createRenderRoot();return this.renderOptions.renderBefore??=t.firstChild,t}update(t){const e=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(t),this._$Do=((t,e,s)=>{const i=s?.renderBefore??e;let o=i._$litPart$;if(void 0===o){const t=s?.renderBefore??null;i._$litPart$=o=new tt(e.insertBefore(M(),t),t,void 0,s??{})}return o._$AI(t),o})(e,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return q}}lt._$litElement$=!0,lt.finalized=!0,at.litElementHydrateSupport?.({LitElement:lt});const ht=at.litElementPolyfillSupport;ht?.({LitElement:lt}),(at.litElementVersions??=[]).push("4.2.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const ct={attribute:!0,type:String,converter:v,reflect:!1,hasChanged:A},dt=(t=ct,e,s)=>{const{kind:i,metadata:o}=s;let n=globalThis.litPropertyMetadata.get(o);if(void 0===n&&globalThis.litPropertyMetadata.set(o,n=new Map),"setter"===i&&((t=Object.create(t)).wrapped=!0),n.set(s.name,t),"accessor"===i){const{name:i}=s;return{set(s){const o=e.get.call(this);e.set.call(this,s),this.requestUpdate(i,o,t,!0,s)},init(e){return void 0!==e&&this.C(i,void 0,t,e),e}}}if("setter"===i){const{name:i}=s;return function(s){const o=this[i];e.call(this,s),this.requestUpdate(i,o,t,!0,s)}}throw Error("Unsupported decorator location: "+i)};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function pt(t){return(e,s)=>"object"==typeof s?dt(t,e,s):((t,e,s)=>{const i=e.hasOwnProperty(s);return e.constructor.createProperty(s,t),i?Object.getOwnPropertyDescriptor(e,s):void 0})(t,e,s)}
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */const ut=new Map,ft=[1e3,2e3,4e3,8e3,16e3,3e4];function $t(t,e={}){const s=e.wsCtor??("undefined"!=typeof WebSocket?WebSocket:void 0),i=e.fetchImpl??("undefined"!=typeof fetch?fetch:void 0);let o=null,n="idle",r=null,a=0,l=null,h=null,c=!1,d=!1;const p=new Set,u=()=>{for(const t of p)try{t(o)}catch(t){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",t)}},f=t=>{n!==t&&(n=t,u())},$=()=>{null!=l&&(clearTimeout(l),l=null)},_=()=>{null!=h&&(clearTimeout(h),h=null)},g=()=>{if($(),r){r.onopen=null,r.onmessage=null,r.onerror=null,r.onclose=null;try{r.close()}catch{}r=null}},y=()=>{if(c||!s)return;let e;$(),f("idle"===n?"connecting":"reconnecting");try{e=new s(function(t){let e=t.trim().replace(/\/$/,"");return/^https?:\/\//i.test(e)?e=e.replace(/^http/i,"ws"):/^wss?:\/\//i.test(e)||(e=`ws://${e}`),`${e}/ws`}(t))}catch{return void m()}r=e,e.onopen=()=>{c||r!==e||(a=0,f("open"),(()=>{if(d||!i)return;d=!0;const e=function(t,e){let s=t.trim().replace(/\/$/,"");return/^wss?:\/\//i.test(s)?s=s.replace(/^ws/i,"http"):/^https?:\/\//i.test(s)||(s=`http://${s}`),`${s}${e.startsWith("/")?e:`/${e}`}`}(t,"/api/snapshot");i(e).then(t=>t.ok?t.json():null).then(t=>{!c&&t&&null==o&&(o=t,u())}).catch(()=>{})})())},e.onmessage=t=>{if(!c&&r===e)try{const e=JSON.parse("string"==typeof t.data?t.data:"");e&&"snapshot"===e.type&&e.data&&(o=e.data,u())}catch{}},e.onerror=()=>{},e.onclose=()=>{r===e&&(r=null,c?f("closed"):m())}},m=()=>{if(c)return;f("reconnecting");const t=Math.min(a,ft.length-1);a+=1,l=setTimeout(()=>{l=null,y()},ft[t])},v={getSnapshot:()=>o,connectionState:()=>n,subscribe(e){_(),p.add(e);try{e(o)}catch(t){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",t)}return 1===p.size&&null==r&&"open"!==n&&"connecting"!==n&&"reconnecting"!==n&&y(),()=>{p.delete(e)&&0===p.size&&(_(),h=setTimeout(()=>{h=null,0===p.size&&(g(),a=0,d=!1,f("idle"),ut.get(t)===v&&ut.delete(t))},5e3))}},_destroy(){c=!0,_(),g(),f("closed"),p.clear(),ut.get(t)===v&&ut.delete(t)}};return v}class _t extends lt{constructor(){super(...arguments),this.snapshot=null,this._unsubscribe=null}setConfig(t){if(!t)throw new Error("Invalid config");this.config={host:t.host||"http://homeassistant.local:8787",title:t.title||"EcoFlow Panel",refresh_seconds:t.refresh_seconds??30,type:t.type}}effectiveHost(){return this.config?.host||"http://homeassistant.local:8787"}connectedCallback(){super.connectedCallback();const t=function(t){const e=ut.get(t);if(e)return e;const s=$t(t);return ut.set(t,s),s}(this.effectiveHost());this._unsubscribe=t.subscribe(t=>{this.snapshot=t})}disconnectedCallback(){super.disconnectedCallback(),this._unsubscribe&&this._unsubscribe(),this._unsubscribe=null}getCardSize(){return 6}}e([pt({attribute:!1})],_t.prototype,"config",void 0),e([function(t){return pt({...t,state:!0,attribute:!1})}()],_t.prototype,"snapshot",void 0);const gt=a`
  :host {
    --ef-accent: var(--primary-color, #03a9f4);
    --ef-ink: var(--primary-text-color, #212121);
    --ef-muted: var(--secondary-text-color, #757575);
    --ef-panel: var(--card-background-color, #fff);
    --ef-line: var(--divider-color, #e0e0e0);
    --ef-ok: var(--success-color, #4caf50);
    --ef-warn: var(--warning-color, #ff9800);
    --ef-bad: var(--error-color, #f44336);
    --ef-info: var(--info-color, #2196f3);
    --ef-tooltip-bg: var(--ha-card-background, #263238);
    --ef-tooltip-fg: #fff;
  }

  /*
   * Glossary tooltip — keyed off the .ef-glossary spans emitted by the
   * glossary() Lit directive. Because Shadow DOM scopes hide title=
   * attributes from the React-era tooltip path, the new pattern is a
   * pure CSS hover bubble that lives inside the same shadow root as
   * the term it explains.
   */
  .ef-glossary {
    position: relative;
    border-bottom: 1px dotted var(--ef-muted);
    cursor: help;
  }
  .ef-glossary > .ef-tooltip {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--ef-tooltip-bg);
    color: var(--ef-tooltip-fg);
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.35;
    white-space: normal;
    max-width: 260px;
    min-width: 160px;
    width: max-content;
    z-index: 100;
    opacity: 0;
    visibility: hidden;
    transition: opacity 120ms ease;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }
  .ef-glossary:hover > .ef-tooltip,
  .ef-glossary:focus-within > .ef-tooltip {
    opacity: 1;
    visibility: visible;
  }
`;return t.EcoflowFleetCard=class extends _t{render(){return W`
      <ha-card>
        <div class="title">${this.config?.title??"EcoFlow Panel"}</div>
        <div class="status">
          EcoFlow — ${this.snapshot?"live":"connecting (PR1 stub)"}
        </div>
        <div class="status">Host: ${this.effectiveHost()}</div>
      </ha-card>
    `}},t.EcoflowFleetCard.styles=[gt,a`
      :host {
        display: block;
      }
      .title {
        font-weight: 600;
        padding-bottom: 8px;
        color: var(--ef-ink);
      }
      .status {
        color: var(--ef-muted);
        font-size: 0.9em;
      }
      ha-card {
        padding: 16px;
      }
    `],t.EcoflowFleetCard=e([(t=>(e,s)=>{void 0!==s?s.addInitializer(()=>{customElements.define(t,e)}):customElements.define(t,e)})("ecoflow-fleet-card")],t.EcoflowFleetCard),window.customCards=window.customCards||[],window.customCards.push({type:"ecoflow-fleet-card",name:"EcoFlow Fleet Card",description:"Top-level dashboard for EcoFlow off-grid system"}),t}({});
//# sourceMappingURL=ecoflow-fleet-card.js.map
