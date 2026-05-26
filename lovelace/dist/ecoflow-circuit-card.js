var EcoflowCircuitCard=function(e){"use strict";function t(e,t,i,s){var r,o=arguments.length,n=o<3?t:null===s?s=Object.getOwnPropertyDescriptor(t,i):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(e,t,i,s);else for(var a=e.length-1;a>=0;a--)(r=e[a])&&(n=(o<3?r(n):o>3?r(t,i,n):r(t,i))||n);return o>3&&n&&Object.defineProperty(t,i,n),n}"function"==typeof SuppressedError&&SuppressedError;
/**
     * @license
     * Copyright 2019 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const i=globalThis,s=i.ShadowRoot&&(void 0===i.ShadyCSS||i.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,r=Symbol(),o=new WeakMap;let n=class{constructor(e,t,i){if(this._$cssResult$=!0,i!==r)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o;const t=this.t;if(s&&void 0===e){const i=void 0!==t&&1===t.length;i&&(e=o.get(t)),void 0===e&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),i&&o.set(t,e))}return e}toString(){return this.cssText}};const a=(e,...t)=>{const i=1===e.length?e[0]:t.reduce((t,i,s)=>t+(e=>{if(!0===e._$cssResult$)return e.cssText;if("number"==typeof e)return e;throw Error("Value passed to 'css' function must be a 'css' function result: "+e+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(i)+e[s+1],e[0]);return new n(i,e,r)},l=s?e=>e:e=>e instanceof CSSStyleSheet?(e=>{let t="";for(const i of e.cssRules)t+=i.cssText;return(e=>new n("string"==typeof e?e:e+"",void 0,r))(t)})(e):e,{is:c,defineProperty:h,getOwnPropertyDescriptor:d,getOwnPropertyNames:p,getOwnPropertySymbols:u,getPrototypeOf:f}=Object,g=globalThis,m=g.trustedTypes,v=m?m.emptyScript:"",y=g.reactiveElementPolyfillSupport,b=(e,t)=>e,$={toAttribute(e,t){switch(t){case Boolean:e=e?v:null;break;case Object:case Array:e=null==e?e:JSON.stringify(e)}return e},fromAttribute(e,t){let i=e;switch(t){case Boolean:i=null!==e;break;case Number:i=null===e?null:Number(e);break;case Object:case Array:try{i=JSON.parse(e)}catch(e){i=null}}return i}},w=(e,t)=>!c(e,t),_={attribute:!0,type:String,converter:$,reflect:!1,useDefault:!1,hasChanged:w};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */Symbol.metadata??=Symbol("metadata"),g.litPropertyMetadata??=new WeakMap;let k=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=_){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){const i=Symbol(),s=this.getPropertyDescriptor(e,i,t);void 0!==s&&h(this.prototype,e,s)}}static getPropertyDescriptor(e,t,i){const{get:s,set:r}=d(this.prototype,e)??{get(){return this[t]},set(e){this[t]=e}};return{get:s,set(t){const o=s?.call(this);r?.call(this,t),this.requestUpdate(e,o,i)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??_}static _$Ei(){if(this.hasOwnProperty(b("elementProperties")))return;const e=f(this);e.finalize(),void 0!==e.l&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(b("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(b("properties"))){const e=this.properties,t=[...p(e),...u(e)];for(const i of t)this.createProperty(i,e[i])}const e=this[Symbol.metadata];if(null!==e){const t=litPropertyMetadata.get(e);if(void 0!==t)for(const[e,i]of t)this.elementProperties.set(e,i)}this._$Eh=new Map;for(const[e,t]of this.elementProperties){const i=this._$Eu(e,t);void 0!==i&&this._$Eh.set(i,e)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){const t=[];if(Array.isArray(e)){const i=new Set(e.flat(1/0).reverse());for(const e of i)t.unshift(l(e))}else void 0!==e&&t.push(l(e));return t}static _$Eu(e,t){const i=t.attribute;return!1===i?void 0:"string"==typeof i?i:"string"==typeof e?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),void 0!==this.renderRoot&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){const e=new Map,t=this.constructor.elementProperties;for(const i of t.keys())this.hasOwnProperty(i)&&(e.set(i,this[i]),delete this[i]);e.size>0&&(this._$Ep=e)}createRenderRoot(){const e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return((e,t)=>{if(s)e.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(const s of t){const t=document.createElement("style"),r=i.litNonce;void 0!==r&&t.setAttribute("nonce",r),t.textContent=s.cssText,e.appendChild(t)}})(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,i){this._$AK(e,i)}_$ET(e,t){const i=this.constructor.elementProperties.get(e),s=this.constructor._$Eu(e,i);if(void 0!==s&&!0===i.reflect){const r=(void 0!==i.converter?.toAttribute?i.converter:$).toAttribute(t,i.type);this._$Em=e,null==r?this.removeAttribute(s):this.setAttribute(s,r),this._$Em=null}}_$AK(e,t){const i=this.constructor,s=i._$Eh.get(e);if(void 0!==s&&this._$Em!==s){const e=i.getPropertyOptions(s),r="function"==typeof e.converter?{fromAttribute:e.converter}:void 0!==e.converter?.fromAttribute?e.converter:$;this._$Em=s;const o=r.fromAttribute(t,e.type);this[s]=o??this._$Ej?.get(s)??o,this._$Em=null}}requestUpdate(e,t,i,s=!1,r){if(void 0!==e){const o=this.constructor;if(!1===s&&(r=this[e]),i??=o.getPropertyOptions(e),!((i.hasChanged??w)(r,t)||i.useDefault&&i.reflect&&r===this._$Ej?.get(e)&&!this.hasAttribute(o._$Eu(e,i))))return;this.C(e,t,i)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(e,t,{useDefault:i,reflect:s,wrapped:r},o){i&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,o??t??this[e]),!0!==r||void 0!==o)||(this._$AL.has(e)||(this.hasUpdated||i||(t=void 0),this._$AL.set(e,t)),!0===s&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(e){Promise.reject(e)}const e=this.scheduleUpdate();return null!=e&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[e,t]of this._$Ep)this[e]=t;this._$Ep=void 0}const e=this.constructor.elementProperties;if(e.size>0)for(const[t,i]of e){const{wrapped:e}=i,s=this[t];!0!==e||this._$AL.has(t)||void 0===s||this.C(t,void 0,i,s)}}let e=!1;const t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(e=>e.hostUpdate?.()),this.update(t)):this._$EM()}catch(t){throw e=!1,this._$EM(),t}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(e=>this._$ET(e,this[e])),this._$EM()}updated(e){}firstUpdated(e){}};k.elementStyles=[],k.shadowRootOptions={mode:"open"},k[b("elementProperties")]=new Map,k[b("finalized")]=new Map,y?.({ReactiveElement:k}),(g.reactiveElementVersions??=[]).push("2.1.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const x=globalThis,A=e=>e,S=x.trustedTypes,C=S?S.createPolicy("lit-html",{createHTML:e=>e}):void 0,E="$lit$",P=`lit$${Math.random().toFixed(9).slice(2)}$`,T="?"+P,H=`<${T}>`,M=document,U=()=>M.createComment(""),O=e=>null===e||"object"!=typeof e&&"function"!=typeof e,j=Array.isArray,N="[ \t\n\f\r]",R=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,z=/-->/g,D=/>/g,L=RegExp(`>|${N}(?:([^\\s"'>=/]+)(${N}*=${N}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,"g"),W=/'/g,I=/"/g,B=/^(?:script|style|textarea|title)$/i,F=(e=>(t,...i)=>({_$litType$:e,strings:t,values:i}))(1),q=Symbol.for("lit-noChange"),V=Symbol.for("lit-nothing"),J=new WeakMap,K=M.createTreeWalker(M,129);function Y(e,t){if(!j(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return void 0!==C?C.createHTML(t):t}const G=(e,t)=>{const i=e.length-1,s=[];let r,o=2===t?"<svg>":3===t?"<math>":"",n=R;for(let t=0;t<i;t++){const i=e[t];let a,l,c=-1,h=0;for(;h<i.length&&(n.lastIndex=h,l=n.exec(i),null!==l);)h=n.lastIndex,n===R?"!--"===l[1]?n=z:void 0!==l[1]?n=D:void 0!==l[2]?(B.test(l[2])&&(r=RegExp("</"+l[2],"g")),n=L):void 0!==l[3]&&(n=L):n===L?">"===l[0]?(n=r??R,c=-1):void 0===l[1]?c=-2:(c=n.lastIndex-l[2].length,a=l[1],n=void 0===l[3]?L:'"'===l[3]?I:W):n===I||n===W?n=L:n===z||n===D?n=R:(n=L,r=void 0);const d=n===L&&e[t+1].startsWith("/>")?" ":"";o+=n===R?i+H:c>=0?(s.push(a),i.slice(0,c)+E+i.slice(c)+P+d):i+P+(-2===c?t:d)}return[Y(e,o+(e[i]||"<?>")+(2===t?"</svg>":3===t?"</math>":"")),s]};class Z{constructor({strings:e,_$litType$:t},i){let s;this.parts=[];let r=0,o=0;const n=e.length-1,a=this.parts,[l,c]=G(e,t);if(this.el=Z.createElement(l,i),K.currentNode=this.el.content,2===t||3===t){const e=this.el.content.firstChild;e.replaceWith(...e.childNodes)}for(;null!==(s=K.nextNode())&&a.length<n;){if(1===s.nodeType){if(s.hasAttributes())for(const e of s.getAttributeNames())if(e.endsWith(E)){const t=c[o++],i=s.getAttribute(e).split(P),n=/([.?@])?(.*)/.exec(t);a.push({type:1,index:r,name:n[2],strings:i,ctor:"."===n[1]?ie:"?"===n[1]?se:"@"===n[1]?re:te}),s.removeAttribute(e)}else e.startsWith(P)&&(a.push({type:6,index:r}),s.removeAttribute(e));if(B.test(s.tagName)){const e=s.textContent.split(P),t=e.length-1;if(t>0){s.textContent=S?S.emptyScript:"";for(let i=0;i<t;i++)s.append(e[i],U()),K.nextNode(),a.push({type:2,index:++r});s.append(e[t],U())}}}else if(8===s.nodeType)if(s.data===T)a.push({type:2,index:r});else{let e=-1;for(;-1!==(e=s.data.indexOf(P,e+1));)a.push({type:7,index:r}),e+=P.length-1}r++}}static createElement(e,t){const i=M.createElement("template");return i.innerHTML=e,i}}function Q(e,t,i=e,s){if(t===q)return t;let r=void 0!==s?i._$Co?.[s]:i._$Cl;const o=O(t)?void 0:t._$litDirective$;return r?.constructor!==o&&(r?._$AO?.(!1),void 0===o?r=void 0:(r=new o(e),r._$AT(e,i,s)),void 0!==s?(i._$Co??=[])[s]=r:i._$Cl=r),void 0!==r&&(t=Q(e,r._$AS(e,t.values),r,s)),t}class X{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){const{el:{content:t},parts:i}=this._$AD,s=(e?.creationScope??M).importNode(t,!0);K.currentNode=s;let r=K.nextNode(),o=0,n=0,a=i[0];for(;void 0!==a;){if(o===a.index){let t;2===a.type?t=new ee(r,r.nextSibling,this,e):1===a.type?t=new a.ctor(r,a.name,a.strings,this,e):6===a.type&&(t=new oe(r,this,e)),this._$AV.push(t),a=i[++n]}o!==a?.index&&(r=K.nextNode(),o++)}return K.currentNode=M,s}p(e){let t=0;for(const i of this._$AV)void 0!==i&&(void 0!==i.strings?(i._$AI(e,i,t),t+=i.strings.length-2):i._$AI(e[t])),t++}}class ee{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,i,s){this.type=2,this._$AH=V,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=i,this.options=s,this._$Cv=s?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode;const t=this._$AM;return void 0!==t&&11===e?.nodeType&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=Q(this,e,t),O(e)?e===V||null==e||""===e?(this._$AH!==V&&this._$AR(),this._$AH=V):e!==this._$AH&&e!==q&&this._(e):void 0!==e._$litType$?this.$(e):void 0!==e.nodeType?this.T(e):(e=>j(e)||"function"==typeof e?.[Symbol.iterator])(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==V&&O(this._$AH)?this._$AA.nextSibling.data=e:this.T(M.createTextNode(e)),this._$AH=e}$(e){const{values:t,_$litType$:i}=e,s="number"==typeof i?this._$AC(e):(void 0===i.el&&(i.el=Z.createElement(Y(i.h,i.h[0]),this.options)),i);if(this._$AH?._$AD===s)this._$AH.p(t);else{const e=new X(s,this),i=e.u(this.options);e.p(t),this.T(i),this._$AH=e}}_$AC(e){let t=J.get(e.strings);return void 0===t&&J.set(e.strings,t=new Z(e)),t}k(e){j(this._$AH)||(this._$AH=[],this._$AR());const t=this._$AH;let i,s=0;for(const r of e)s===t.length?t.push(i=new ee(this.O(U()),this.O(U()),this,this.options)):i=t[s],i._$AI(r),s++;s<t.length&&(this._$AR(i&&i._$AB.nextSibling,s),t.length=s)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){const t=A(e).nextSibling;A(e).remove(),e=t}}setConnected(e){void 0===this._$AM&&(this._$Cv=e,this._$AP?.(e))}}class te{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,i,s,r){this.type=1,this._$AH=V,this._$AN=void 0,this.element=e,this.name=t,this._$AM=s,this.options=r,i.length>2||""!==i[0]||""!==i[1]?(this._$AH=Array(i.length-1).fill(new String),this.strings=i):this._$AH=V}_$AI(e,t=this,i,s){const r=this.strings;let o=!1;if(void 0===r)e=Q(this,e,t,0),o=!O(e)||e!==this._$AH&&e!==q,o&&(this._$AH=e);else{const s=e;let n,a;for(e=r[0],n=0;n<r.length-1;n++)a=Q(this,s[i+n],t,n),a===q&&(a=this._$AH[n]),o||=!O(a)||a!==this._$AH[n],a===V?e=V:e!==V&&(e+=(a??"")+r[n+1]),this._$AH[n]=a}o&&!s&&this.j(e)}j(e){e===V?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}}class ie extends te{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===V?void 0:e}}class se extends te{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==V)}}class re extends te{constructor(e,t,i,s,r){super(e,t,i,s,r),this.type=5}_$AI(e,t=this){if((e=Q(this,e,t,0)??V)===q)return;const i=this._$AH,s=e===V&&i!==V||e.capture!==i.capture||e.once!==i.once||e.passive!==i.passive,r=e!==V&&(i===V||s);s&&this.element.removeEventListener(this.name,this,i),r&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){"function"==typeof this._$AH?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}}class oe{constructor(e,t,i){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=i}get _$AU(){return this._$AM._$AU}_$AI(e){Q(this,e)}}const ne=x.litHtmlPolyfillSupport;ne?.(Z,ee),(x.litHtmlVersions??=[]).push("3.3.3");const ae=globalThis;
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */class le extends k{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){const t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=((e,t,i)=>{const s=i?.renderBefore??t;let r=s._$litPart$;if(void 0===r){const e=i?.renderBefore??null;s._$litPart$=r=new ee(t.insertBefore(U(),e),e,void 0,i??{})}return r._$AI(e),r})(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return q}}le._$litElement$=!0,le.finalized=!0,ae.litElementHydrateSupport?.({LitElement:le});const ce=ae.litElementPolyfillSupport;ce?.({LitElement:le}),(ae.litElementVersions??=[]).push("4.2.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const he={attribute:!0,type:String,converter:$,reflect:!1,hasChanged:w},de=(e=he,t,i)=>{const{kind:s,metadata:r}=i;let o=globalThis.litPropertyMetadata.get(r);if(void 0===o&&globalThis.litPropertyMetadata.set(r,o=new Map),"setter"===s&&((e=Object.create(e)).wrapped=!0),o.set(i.name,e),"accessor"===s){const{name:s}=i;return{set(i){const r=t.get.call(this);t.set.call(this,i),this.requestUpdate(s,r,e,!0,i)},init(t){return void 0!==t&&this.C(s,void 0,e,t),t}}}if("setter"===s){const{name:s}=i;return function(i){const r=this[s];t.call(this,i),this.requestUpdate(s,r,e,!0,i)}}throw Error("Unsupported decorator location: "+s)};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function pe(e){return(t,i)=>"object"==typeof i?de(e,t,i):((e,t,i)=>{const s=t.hasOwnProperty(i);return t.constructor.createProperty(i,e),s?Object.getOwnPropertyDescriptor(t,i):void 0})(e,t,i)}
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function ue(e){return pe({...e,state:!0,attribute:!1})}const fe=new Map,ge=[1e3,2e3,4e3,8e3,16e3,3e4];function me(e,t={}){const i=t.wsCtor??("undefined"!=typeof WebSocket?WebSocket:void 0),s=t.fetchImpl??("undefined"!=typeof fetch?fetch:void 0);let r=null,o="idle",n=null,a=0,l=null,c=null,h=!1,d=!1;const p=new Set,u=()=>{for(const e of p)try{e(r)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}},f=e=>{o!==e&&(o=e,u())},g=()=>{null!=l&&(clearTimeout(l),l=null)},m=()=>{null!=c&&(clearTimeout(c),c=null)},v=()=>{if(g(),n){n.onopen=null,n.onmessage=null,n.onerror=null,n.onclose=null;try{n.close()}catch{}n=null}},y=()=>{if(h||!i)return;let t;g(),f("idle"===o?"connecting":"reconnecting");try{t=new i(function(e){let t=e.trim().replace(/\/$/,"");return/^https?:\/\//i.test(t)?t=t.replace(/^http/i,"ws"):/^wss?:\/\//i.test(t)||(t=`ws://${t}`),`${t}/ws`}(e))}catch{return void b()}n=t,t.onopen=()=>{h||n!==t||(a=0,f("open"),(()=>{if(d||!s)return;d=!0;const t=function(e,t){let i=e.trim().replace(/\/$/,"");return/^wss?:\/\//i.test(i)?i=i.replace(/^ws/i,"http"):/^https?:\/\//i.test(i)||(i=`http://${i}`),`${i}${t.startsWith("/")?t:`/${t}`}`}(e,"/api/snapshot");s(t).then(e=>e.ok?e.json():null).then(e=>{!h&&e&&null==r&&(r=e,u())}).catch(()=>{})})())},t.onmessage=e=>{if(!h&&n===t)try{const t=JSON.parse("string"==typeof e.data?e.data:"");t&&"snapshot"===t.type&&t.data&&(r=t.data,u())}catch{}},t.onerror=()=>{},t.onclose=()=>{n===t&&(n=null,h?f("closed"):b())}},b=()=>{if(h)return;f("reconnecting");const e=Math.min(a,ge.length-1);a+=1,l=setTimeout(()=>{l=null,y()},ge[e])},$={getSnapshot:()=>r,connectionState:()=>o,subscribe(t){m(),p.add(t);try{t(r)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}return 1===p.size&&null==n&&"open"!==o&&"connecting"!==o&&"reconnecting"!==o&&y(),()=>{p.delete(t)&&0===p.size&&(m(),c=setTimeout(()=>{c=null,0===p.size&&(v(),a=0,d=!1,f("idle"),fe.get(e)===$&&fe.delete(e))},5e3))}},_destroy(){h=!0,m(),v(),f("closed"),p.clear(),fe.get(e)===$&&fe.delete(e)}};return $}class ve extends le{constructor(){super(...arguments),this.snapshot=null,this.connState="idle",this._unsubscribe=null,this._stateTimer=null}setConfig(e){if(!e)throw new Error("Invalid config");this.config={host:e.host||"http://homeassistant.local:8787",title:e.title||"EcoFlow Panel",refresh_seconds:e.refresh_seconds??30,type:e.type}}effectiveHost(){return this.config?.host||"http://homeassistant.local:8787"}connectedCallback(){super.connectedCallback();const e=function(e){const t=fe.get(e);if(t)return t;const i=me(e);return fe.set(e,i),i}(this.effectiveHost());this.connState=e.connectionState(),this._unsubscribe=e.subscribe(t=>{this.snapshot=t,this.connState=e.connectionState()})}disconnectedCallback(){super.disconnectedCallback(),this._unsubscribe&&this._unsubscribe(),this._unsubscribe=null,this._stateTimer&&(clearInterval(this._stateTimer),this._stateTimer=null)}getCardSize(){return 6}}t([pe({attribute:!1})],ve.prototype,"config",void 0),t([ue()],ve.prototype,"snapshot",void 0),t([ue()],ve.prototype,"connState",void 0);const ye=a`
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
`,be={};function $e(e,t){for(const i of e.split("|"))be[i.trim()]=t}function we(e){const t=function(e){const t=function(e){return e.split("·")[0].split("(")[0].replace(/\s+/g," ").trim().toLowerCase()}(e);return t?be[t]:void 0}(e);return t?F`<span class="ef-glossary"
    >${e}<span class="ef-tooltip" role="tooltip">${t}</span></span
  >`:e}$e("soc|state of charge","State of charge — how full the battery is right now, 0–100%."),$e("avg soc","Average state of charge across every online battery pack in the fleet."),$e("soh|state of health|avg soh","State of health — measured usable capacity vs the pack’s original design capacity. A wear gauge; 100% = like-new."),$e("ocv|open-circuit","Open-circuit voltage — the pack’s resting voltage with no load applied."),$e("cell spread|worst cell spread|cell imbalance|cell spread now","Cell-voltage spread — the gap between the highest and lowest cell in a pack. A widening gap is an early sign of imbalance."),$e("cell mean","Average voltage across all of the pack’s cells."),$e("pack volt","Pack terminal voltage."),$e("rep temp","Representative pack temperature reported by the BMS."),$e("cell max|cell min","Hottest / coldest individual cell temperature in the pack."),$e("cell temperatures","Per-cell temperature sensors inside the pack."),$e("cell voltages","Per-cell voltage, each shown with its deviation from the pack mean."),$e("mos max|mosfet temperatures|mosfet temps|mosfet","Power-MOSFET temperature — the BMS switching transistors."),$e("board","BMS circuit-board temperature."),$e("shunt","Current-shunt temperature — the precision resistor the BMS measures pack current across."),$e("ptc heater temperatures|ptc heater temps|ptc","PTC heater temperature — keeps the cells warm enough to charge safely in the cold."),$e("cycles","Equivalent full charge/discharge cycles the pack has completed — a measure of battery age."),$e("lifetime throughput","Total energy ever charged into and discharged out of the pack."),$e("capacity","Energy the battery can store, in kWh."),$e("balancing|cells balancing","The BMS is equalizing cell voltages — routine housekeeping, no action needed."),$e("hottest pack","The warmest pack across the fleet right now."),$e("vitals","The pack’s key live readings at a glance."),$e("pv|pv in|pv total|photovoltaic","Photovoltaic — solar-panel power."),$e("pv high mppt|pv low mppt","Power from one of the DPU’s two solar strings (high- or low-voltage MPPT input)."),$e("ac out|ac output","AC power flowing out of the inverter to your loads."),$e("ac in","AC power flowing into the inverter — grid or generator charging."),$e("ac out freq / v","Inverter AC output frequency (Hz) and voltage."),$e("total in / out","Total power into and out of the DPU across every input and output."),$e("battery v / a","Internal battery-bus voltage and current."),$e("in|out","Power flowing in to / out of the device."),$e("input|output","Power flowing into (charging) or out of (discharging) the pack."),$e("panel load","Total power the SHP2’s circuits are drawing right now."),$e("live contribution|live draw","Power this device is feeding/drawing right now."),$e("voltage|current","Live electrical voltage / current at this input."),$e("v × a","Voltage × current — instantaneous power, shown as a cross-check on the reported watts."),$e("string ω","Effective resistance (volts ÷ amps) at the MPPT string’s operating point."),$e("mppt|mppt temp|mppt hv|mppt lv|hv mppt|lv mppt","MPPT — the solar charge controller (Maximum Power Point Tracker). Each DPU has two: a high-voltage and a low-voltage string input."),$e("hv channels|lv channels","High-/low-voltage MPPT solar string inputs — one of each per DPU."),$e("ghi","Global Horizontal Irradiance — total sunlight energy on a flat surface (W/m²); the raw “how sunny” number the forecast is built from."),$e("producing now","Solar power being generated right now."),$e("peak today","The highest solar power reached so far today."),$e("coefficient|peak response|response coefficient","Learned response coefficient — watts of PV produced per W/m² of sunlight. Captures panel size, orientation, shading and inverter clipping."),$e("strongest hour","The hour of day your arrays convert sunlight to power most efficiently — reveals their orientation."),$e("observed peak pv","The highest PV output actually recorded at this hour-of-day."),$e("soiling","Dust/pollen on the panels cutting output. Detected by comparing clear-sky production to the cleanest day on record."),$e("output drop","How far clear-sky solar output has fallen below the clean-panel baseline — the soiling indicator."),$e("backup|backup pool","SHP2 backup pool — the combined battery the Smart Home Panel draws on."),$e("backup %","Backup-pool state of charge, trended over the last hour."),$e("reserve floor|backup reserve|reserve","Reserve floor — the state of charge held back for backup. Loads begin shedding below it."),$e("solar reserve","Target state of charge to keep in reserve specifically when running on solar."),$e("mid-priority floor","The SoC at which mid-priority circuits are cut to protect the battery."),$e("charge power","Power currently flowing into the battery."),$e("charge time","Estimated time to fully charge the battery."),$e("rated power","The device’s rated maximum power output."),$e("ems bat temp","Battery temperature as reported by the SHP2’s energy-management system."),$e("hw link","Hardware (wired) link status between the SHP2 and this DPU."),$e("load-shed strategy","The SHP2’s automatic plan for dropping circuits as the battery depletes."),$e("smart backup mode","The SHP2’s backup-behaviour mode setting."),$e("charge schedule","The SHP2’s time-of-use scheduled charging windows."),$e("error code|direct errors|shp2 errors","Device-reported error code — 0 means no fault."),$e("charging power","Power the EV charger is drawing, over the last 24 hours."),$e("sessions today","Charging sessions detected today — a sustained draw above 1 kW."),$e("host dpu|dpu battery","The Delta Pro Ultra the EV charger is wired to — that DPU’s AC output equals the charging draw."),$e("direct telemetry|direct evse telemetry","Raw data straight from the device over MQTT, rather than inferred."),$e("solar next 24 h|solar next 24h","Projected solar production, from the cloud forecast run through your learned array model."),$e("forecast load|forecast load 24 h|typical solar / day","Projected household load from the typical-day consumption curve."),$e("forecast pv","Projected PV output for this hour."),$e("projected low soc","The lowest the battery is forecast to reach over the next 24 hours."),$e("cloud cover","Forecast cloud cover — what derates the solar prediction each hour."),$e("outlook","At-a-glance battery comfort vs the reserve floor: Comfortable, Watch or Tight."),$e("history depth","Days of recorded data behind the forecast and learned models — they sharpen as it grows."),$e("confidence","How trustworthy the learned model is, based on how many samples it has."),$e("z-score|peer z-score","Modified z-score — how many robust deviations a reading sits from normal. Higher = more anomalous; ≥ 3.5 flags, ≥ 5 warns."),$e("fit quality|fit r²","R-squared — how well the trend line fits the data, 0–1. Higher means a more trustworthy projection."),$e("samples|regression samples","How many data points the estimate is built from — more points, more reliable."),$e("sibling median","The median reading across the pack’s four siblings — the “normal” this pack is compared against."),$e("this pack","This pack’s current reading."),$e("deviation","How far this reading sits from the expected/normal value."),$e("baseline window","The span of history and number of samples behind the self-baseline."),$e("decline rate|rise rate","How fast the value is changing, per unit time."),$e("end-of-life|eol|projected eol|reaches 80%","End of life — the 80%-SoH point where a pack has lost a fifth of its original capacity; the conventional LFP replacement mark."),$e("fade rate|fade / yr|avg fade rate","How fast measured capacity (State of Health) is falling — SoH percentage points lost per year."),$e("service left|years left|years to eol","Projected years of service remaining before the pack reaches the 80% end-of-life threshold."),$e("eol threshold","The State of Health at which a pack counts as end-of-life — conventionally 80% for LFP cells."),$e("packs projecting","How many packs have a firm enough SoH trend to project an end-of-life date."),$e("soonest eol","The pack across the fleet projected to reach end-of-life first."),$e("cycles at eol","Projected equivalent full-cycle count by the time the pack reaches end-of-life."),$e("data span","Days of recorded history the projection is regressed over."),$e("projection notes","Plain-language end-of-life verdict for each pack with a firm fade trend."),$e("trend","Whether a pack has a projected fade trend, is stable, is still learning, or has no data yet."),$e("critical","Critical — an immediate problem that needs attention now."),$e("warnings|warning","Warning — something to investigate soon."),$e("informational|info","Informational — noted for awareness, not urgent."),$e("anomalies","Things unusual right now — flagged by peer comparison and self-baseline."),$e("forecasts","Where things are heading — runtime, degradation and day-ahead projections."),$e("actionable","Critical + warning items that may need attention."),$e("recently cleared","Alerts that were raised and have since resolved, with how long each lasted."),$e("today","Energy totals since local midnight."),$e("solar produced","Total solar energy harvested today."),$e("batteries","Net battery energy today — negative means net charged, positive means net discharged.");const _e=e=>null==e?"—":Math.abs(e)>=1e3?`${(e/1e3).toFixed(2)} kW`:`${Math.round(e)} W`;function ke(e,t,i,s){const r=t-e||1,o=s-i;return t=>i+(t-e)/r*o}function xe(e,t={}){const i=t.width??320,s=t.height??40,r=t.color??"var(--ef-accent)",o=e.map(e=>e.value).filter(e=>null!=e&&Number.isFinite(e));if(o.length<2)return F`<div style="height:${s}px;color:var(--ef-muted);font-size:10px;">collecting…</div>`;const n=Math.min(...o),a=Math.max(...o),l=.05*(a-n)||1,c=t.yMin??n-l,h=t.yMax??a+l,d=function(e,t,i){const s=[];let r=!1;for(const o of e){if(null==o.value||!Number.isFinite(o.value)){r=!1;continue}const e=t(o.ts),n=i(o.value);s.push(`${r?"L":"M"} ${e.toFixed(1)} ${n.toFixed(1)}`),r=!0}return s.join(" ")}(e,ke(e[0].ts,e[e.length-1].ts,2,i-2),ke(c,h,s-2,2));return F`
    <svg viewBox="0 0 ${i} ${s}" width="100%" height="${s}" preserveAspectRatio="none" aria-hidden="true">
      <path d=${d} fill="none" stroke=${r} stroke-width="1.5" />
    </svg>
  `}class Ae extends le{constructor(){super(...arguments),this.tone="neutral"}render(){return F`<slot></slot>`}}Ae.styles=[ye,a`
      :host {
        display: inline-flex;
        align-items: center;
        font-size: 0.75rem;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 999px;
        line-height: 1.5;
        background: var(--ef-line);
        color: var(--ef-ink);
        white-space: nowrap;
      }
      :host([tone='ok']) {
        background: color-mix(in srgb, var(--ef-ok) 20%, transparent);
        color: var(--ef-ok);
      }
      :host([tone='warn']) {
        background: color-mix(in srgb, var(--ef-warn) 22%, transparent);
        color: var(--ef-warn);
      }
      :host([tone='bad']) {
        background: color-mix(in srgb, var(--ef-bad) 22%, transparent);
        color: var(--ef-bad);
      }
      :host([tone='info']) {
        background: color-mix(in srgb, var(--ef-info) 22%, transparent);
        color: var(--ef-info);
      }
    `],t([pe({reflect:!0})],Ae.prototype,"tone",void 0),customElements.get("ef-badge")||customElements.define("ef-badge",Ae);class Se extends le{constructor(){super(...arguments),this.label="",this.value="",this.unit=""}render(){return F`
      <div class="label"><slot name="label">${this.label}</slot></div>
      <div class="value-line">
        <span class="value"><slot name="value">${this.value}</slot></span>
        ${this.unit?F`<span class="unit">${this.unit}</span>`:null}
      </div>
      <slot></slot>
    `}}Se.styles=[ye,a`
      :host {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 12px;
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        background: var(--ef-panel);
        min-width: 88px;
      }
      .label {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--ef-muted);
        line-height: 1.2;
      }
      .value-line {
        display: flex;
        align-items: baseline;
        gap: 4px;
        color: var(--ef-ink);
      }
      .value {
        font-size: 1.4rem;
        font-weight: 600;
        line-height: 1.1;
      }
      .unit {
        font-size: 0.8rem;
        color: var(--ef-muted);
      }
      ::slotted(*) {
        font-size: 0.75rem;
        color: var(--ef-muted);
      }
    `],t([pe()],Se.prototype,"label",void 0),t([pe()],Se.prototype,"value",void 0),t([pe()],Se.prototype,"unit",void 0),customElements.get("ef-tile")||customElements.define("ef-tile",Se);class Ce extends le{constructor(){super(...arguments),this.title=""}render(){return F`
      <header>
        <div class="title"><slot name="title">${this.title}</slot></div>
        <div class="header-extra"><slot name="header"></slot></div>
      </header>
      <div class="body"><slot></slot></div>
    `}}Ce.styles=[ye,a`
      :host {
        display: block;
        border: 1px solid var(--ef-line);
        border-radius: 10px;
        background: var(--ef-panel);
        padding: 12px 14px;
        color: var(--ef-ink);
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }
      .title {
        font-weight: 600;
        font-size: 0.95rem;
      }
      .header-extra {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.8rem;
        color: var(--ef-muted);
      }
      .body {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
    `],t([pe()],Ce.prototype,"title",void 0),customElements.get("ef-section")||customElements.define("ef-section",Ce);e.EcoflowCircuitCard=class extends ve{constructor(){super(...arguments),this.history24={data:null,stale:!1},this.historyMulti={data:null,stale:!1},this.setupError=null,this._httpTimer=null}setConfig(e){if(!e)throw new Error("Invalid config: missing config object");if(null==e.circuit)throw new Error("circuit is required — add `circuit: <1-12>` to the card YAML (SHP2 channel number)");if("number"!=typeof e.circuit||!Number.isFinite(e.circuit))throw new Error("circuit must be a number (got "+JSON.stringify(e.circuit)+")");if(!Number.isInteger(e.circuit)||e.circuit<1||e.circuit>12)throw new Error("circuit must be an integer between 1 and 12 (got "+e.circuit+")");if(null!=e.cost_per_kwh&&("number"!=typeof e.cost_per_kwh||!Number.isFinite(e.cost_per_kwh)||e.cost_per_kwh<0))throw new Error("cost_per_kwh must be a non-negative number (got "+JSON.stringify(e.cost_per_kwh)+")");super.setConfig(e),this.config={...this.config,circuit:e.circuit,cost_per_kwh:e.cost_per_kwh},this.setupError=null}connectedCallback(){super.connectedCallback();const e=Math.max(15,this.config?.refresh_seconds??60);this._kickHttp(),this._httpTimer=setInterval(()=>this._kickHttp(),1e3*e)}disconnectedCallback(){super.disconnectedCallback(),this._httpTimer&&(clearInterval(this._httpTimer),this._httpTimer=null)}_kickHttp(){const e=this.circuitContext();if(!e)return;const{sn:t,circuit:i,pair:s}=e,r=!!s&&s.isSplitPhase&&null!=s.secondaryCh,o=r?`pair${s.primaryCh}_w`:`ch${i.ch}_w`,n=r?`pair=${s.primaryCh}`:`ch=${i.ch}`,a=Date.now()-864e5;this._fetch(`/api/history?sn=${encodeURIComponent(t)}&metric=${encodeURIComponent(o)}&since=${a}&bucket=120`,()=>this.history24,e=>this.history24=e),this._fetch(`/api/circuit/history?sn=${encodeURIComponent(t)}&${n}&days=30`,()=>this.historyMulti,e=>this.historyMulti=e)}async _fetch(e,t,i){try{const t=this.effectiveHost().replace(/\/$/,"")+e,s=await fetch(t);if(!s.ok)throw new Error(`HTTP ${s.status}`);i({data:await s.json(),stale:!1})}catch{i({...t(),stale:!0})}}updated(e){super.updated(e),e.has("snapshot")&&null==this.history24.data&&this.snapshot&&this._kickHttp()}connTone(e){return"open"===e?"ok":"connecting"===e||"reconnecting"===e?"warn":"closed"===e?"bad":"neutral"}connLabel(e){return"open"===e?"live":"connecting"===e?"linking":"reconnecting"===e?"reconnecting":"closed"===e?"offline":"idle"}findShp2(){const e=this.snapshot;return e?Object.values(e.devices).find(e=>"shp2"===e.projection?.kind)??null:null}circuitContext(){const e=this.findShp2(),t=this.config?.circuit;if(!e||null==t)return null;const i=e.projection.circuits.find(e=>e.ch===t);if(!i)return null;const s=e.projection.pairedCircuits.find(e=>e.primaryCh===t||e.secondaryCh===t);return{sn:e.sn,circuit:i,pair:s}}todayWh(e){if(e.length<2)return null;const t=new Date;t.setHours(0,0,0,0);const i=t.getTime(),s=e.filter(e=>e.ts>=i&&null!=e.value);if(s.length<2)return 0;let r=0;for(let e=1;e<s.length;e++){const t=s[e].ts-s[e-1].ts;if(t<=0||t>6e5)continue;r+=((s[e-1].value??0)+(s[e].value??0))/2*(t/36e5)}return r}fmtClock(e){return new Date(e).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}render(){if(this.setupError)return F`<ha-card>${this.renderErrorBox(this.setupError)}</ha-card>`;if(!this.config)return F`<ha-card
        >${this.renderErrorBox({message:"Card config not set",hint:"Add `circuit: <1-12>` to the YAML — see card README for an example."})}</ha-card
      >`;const e=this.snapshot,t=this.config.title??`Circuit ${this.config.circuit}`;if(!e)return F`<ha-card>
        <div class="header">
          <div>
            <div class="title">${t}</div>
            <div class="subtitle">${this.effectiveHost()}</div>
          </div>
          <div class="badges">
            <ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge>
          </div>
        </div>
        <div class="skeleton"><span class="dot"></span>Connecting to add-on…</div>
      </ha-card>`;const i=this.findShp2();if(!i)return F`<ha-card>
        ${this.renderErrorBox({message:"No SHP2 device found in this fleet",hint:"This card needs a Smart Home Panel 2 to read circuit data from. Check that the add-on host is correct and the SHP2 is online."})}
      </ha-card>`;const s=this.circuitContext();if(!s){const e=i.projection.circuits.map(e=>e.ch).sort((e,t)=>e-t);return F`<ha-card>
        ${this.renderErrorBox({message:`Circuit ${this.config.circuit} not reported by SHP2 ${i.deviceName}`,hint:`The SHP2 currently knows about these channels: ${e.join(", ")||"—"}. Pick one of those.`})}
      </ha-card>`}return this.renderCard(s,i)}renderErrorBox(e){return F`<div class="error">
      <strong>Configuration error:</strong> ${e.message}
      <div style="margin-top:6px;">${e.hint}</div>
      <pre>
type: custom:ecoflow-circuit-card
host: http://homeassistant.local:8787
circuit: 10    # SHP2 circuit number (1-12)
title: Pool Pump</pre
      >
    </div>`}renderCard(e,t){const{circuit:i,pair:s}=e,r=!!s&&s.isSplitPhase&&null!=s.secondaryCh,o=r?s.watts:i.watts,n=r?s.breakerAmps:i.setAmp,a=this.config?.title??(r?s.name:i.name),l=r?`${t.deviceName} · ch ${s.primaryCh}+${s.secondaryCh} · ${n??"—"}A · 240 V`:`${t.deviceName} · ch ${i.ch} · ${n??"—"}A breaker`,c=this.history24.stale||this.historyMulti.stale;return F`<ha-card>
      <div class="header">
        <div>
          <div class="title">${a}</div>
          <div class="subtitle">${l}</div>
        </div>
        <div class="badges">
          <ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge>
          ${c?F`<ef-badge tone="warn">stale data</ef-badge>`:V}
        </div>
      </div>
      ${this.renderHeadlineRow(o)} ${this.renderHistorySection()}
      ${this.renderLifetimeSection()} ${this.renderPairingSection(s,r)}
    </ha-card>`}renderHeadlineRow(e){const t=this.history24.data?.points??[],i=t.map(e=>e.value).filter(e=>null!=e&&Number.isFinite(e)),s=i.length>0?Math.max(...i):null,r=this.todayWh(t);return F`<div class="full">
      <div class="tiles-row">
        <ef-tile label="Now" value=${_e(e)} unit="">
          <span>live</span>
        </ef-tile>
        <ef-tile label="Today" value=${(e=>null==e?"—":Math.abs(e)>=1e3?`${(e/1e3).toFixed(2)} kWh`:`${Math.round(e)} Wh`)(r)} unit="">
          <span>since local midnight</span>
        </ef-tile>
        <ef-tile label="Peak (24h)" value=${_e(s)} unit="">
          ${this.peakSubtitle(t)}
        </ef-tile>
      </div>
    </div>`}peakSubtitle(e){if(0===e.length)return"";let t=null,i=-1/0;for(const s of e)null!=s.value&&s.value>i&&(i=s.value,t=s.ts);return null==t?"":F`<span>at ${this.fmtClock(t)}</span>`}renderHistorySection(){const e=this.history24.data;return e?e.points.length<2?F`<ef-section .title=${"24-hour power"}>
        <div class="subtitle">Collecting samples — chart appears once history accumulates.</div>
      </ef-section>`:F`<ef-section .title=${"24-hour power"}>
      <div class="full">
        <div class="chart-wrap">
          ${xe(e.points,{height:120,color:"var(--ef-ok)"})}
        </div>
        <div class="chart-meta">${this.historyAnnotation(e.points)}</div>
      </div>
    </ef-section>`:F`<ef-section .title=${"24-hour power"}>
        <div class="subtitle">${this.history24.stale?"History unavailable.":"Loading history…"}</div>
      </ef-section>`}historyAnnotation(e){let t=null,i=-1/0;for(const s of e)null!=s.value&&s.value>i&&(i=s.value,t=s.ts);let s=null,r=null;for(let t=0;t<e.length;t++){const i=e[t];if((i.value??0)<5){null==s&&(s=i.ts);const e=i.ts-s;e>=18e5&&(!r||e>r.end-r.start)&&(r={start:s,end:i.ts})}else s=null}return F`
      ${null!=t?F`<span>Peak ${this.fmtClock(t)}</span>`:V}
      ${r?F`<span>Idle ${this.fmtClock(r.start)}–${this.fmtClock(r.end)}</span>`:V}
    `}renderLifetimeSection(){const e=this.historyMulti.data;if(!e)return F`<ef-section .title=${"30-day lifetime"}>
        <div class="subtitle">
          ${this.historyMulti.stale?"Multi-day history unavailable.":"Loading multi-day history…"}
        </div>
      </ef-section>`;if(0===e.summary.daysWithData)return F`<ef-section .title=${"30-day lifetime"}>
        <div class="subtitle">
          No multi-day history recorded yet — totals appear as the recorder accumulates samples.
        </div>
      </ef-section>`;const t=e.summary.totalKwh,i=this.config?.cost_per_kwh??.17,s=null==this.config?.cost_per_kwh,r=t*i,o=e.summary.peakDay;return F`<ef-section .title=${"30-day lifetime"}>
      <div class="full">
        <div class="kv">
          <span class="k">${we("Lifetime kWh")}</span>
          <span class="v">${t.toFixed(1)} kWh</span>
        </div>
        <div class="kv">
          <span class="k">Avg / day</span>
          <span class="v">${e.summary.avgKwh.toFixed(2)} kWh</span>
        </div>
        <div class="kv">
          <span class="k">Peak day</span>
          <span class="v">${o?`${o.kwh.toFixed(2)} kWh`:"—"}</span>
        </div>
        <div class="kv">
          <span class="k">Cost${s?` (@ $${i.toFixed(2)}/kWh)`:""}</span>
          <span class="v">$${r.toFixed(2)}</span>
        </div>
        <div class="pairing-note">
          ${e.summary.daysWithData}/${e.days.length} days with data${s?" · set `cost_per_kwh:` in the card YAML to override the default rate":""}
        </div>
      </div>
    </ef-section>`}renderPairingSection(e,t){if(!e||!e.isSplitPhase||null==e.secondaryCh)return V;const i=this.config?.circuit;if(t)return F`<ef-section .title=${"Pairing"}>
        <div class="full">
          <div class="pairing-note">
            ${we("Split-phase")}: ch ${e.primaryCh}+${e.secondaryCh} combined as
            ${e.name}. Headline figures above are summed across both legs.
          </div>
        </div>
      </ef-section>`;const s=e.primaryCh===i?e.secondaryCh:e.primaryCh;return F`<ef-section .title=${"Pairing"}>
      <div class="full">
        <div class="pairing-note">
          ${we("Split-phase")}: paired with circuit ${s}. Combined now:
          <strong>${_e(e.watts)}</strong>. For the full 240 V history switch this card to
          <code>circuit: ${e.primaryCh}</code>.
        </div>
      </div>
    </ef-section>`}},e.EcoflowCircuitCard.styles=[ye,a`
      :host { display: block; }
      ha-card { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
      .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
      .title { font-size: 1.1rem; font-weight: 600; color: var(--ef-ink); }
      .subtitle { font-size: 0.75rem; color: var(--ef-muted); margin-top: 2px; }
      .badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .skeleton { padding: 20px; text-align: center; color: var(--ef-muted); font-size: 0.85rem; }
      .skeleton .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ef-accent); margin-right: 6px; animation: ef-pulse 1.2s ease-in-out infinite; }
      @keyframes ef-pulse { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
      .error { padding: 14px; border: 1px solid color-mix(in srgb, var(--ef-bad) 40%, var(--ef-line)); background: color-mix(in srgb, var(--ef-bad) 8%, var(--ef-panel)); border-radius: 8px; color: var(--ef-ink); font-size: 0.85rem; line-height: 1.4; }
      .error strong { color: var(--ef-bad); }
      .error code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.8rem; background: color-mix(in srgb, var(--ef-line) 60%, transparent); padding: 1px 4px; border-radius: 4px; }
      .error pre { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.78rem; background: var(--ef-panel); padding: 8px 10px; border-radius: 6px; border: 1px solid var(--ef-line); margin: 8px 0 0; white-space: pre-wrap; }
      .tiles-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; width: 100%; }
      .full { width: 100%; }
      .chart-wrap { width: 100%; padding: 4px 0; }
      .chart-meta { font-size: 0.72rem; color: var(--ef-muted); margin-top: 4px; display: flex; flex-wrap: wrap; gap: 12px; }
      .kv { display: flex; justify-content: space-between; align-items: baseline; font-size: 0.85rem; color: var(--ef-ink); padding: 2px 0; }
      .kv .k { color: var(--ef-muted); font-size: 0.78rem; }
      .kv .v { font-variant-numeric: tabular-nums; font-weight: 600; }
      .pairing-note { font-size: 0.78rem; color: var(--ef-muted); margin-top: 4px; }
    `],t([ue()],e.EcoflowCircuitCard.prototype,"history24",void 0),t([ue()],e.EcoflowCircuitCard.prototype,"historyMulti",void 0),t([ue()],e.EcoflowCircuitCard.prototype,"setupError",void 0),e.EcoflowCircuitCard=t([(e=>(t,i)=>{void 0!==i?i.addInitializer(()=>{customElements.define(e,t)}):customElements.define(e,t)})("ecoflow-circuit-card")],e.EcoflowCircuitCard);const Ee=window;return Ee.customCards=Ee.customCards||[],Ee.customCards.some(e=>"ecoflow-circuit-card"===e.type)||Ee.customCards.push({type:"ecoflow-circuit-card",name:"EcoFlow Circuit Drill-Down",description:"Per-circuit live power, 24h history, lifetime kWh and cost"}),e}({});
//# sourceMappingURL=ecoflow-circuit-card.js.map
