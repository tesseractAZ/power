var EcoflowBatteryCard=function(e){"use strict";function t(e,t,s,r){var o,a=arguments.length,i=a<3?t:null===r?r=Object.getOwnPropertyDescriptor(t,s):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)i=Reflect.decorate(e,t,s,r);else for(var n=e.length-1;n>=0;n--)(o=e[n])&&(i=(a<3?o(i):a>3?o(t,s,i):o(t,s))||i);return a>3&&i&&Object.defineProperty(t,s,i),i}"function"==typeof SuppressedError&&SuppressedError;
/**
     * @license
     * Copyright 2019 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const s=globalThis,r=s.ShadowRoot&&(void 0===s.ShadyCSS||s.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,o=Symbol(),a=new WeakMap;let i=class{constructor(e,t,s){if(this._$cssResult$=!0,s!==o)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o;const t=this.t;if(r&&void 0===e){const s=void 0!==t&&1===t.length;s&&(e=a.get(t)),void 0===e&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),s&&a.set(t,e))}return e}toString(){return this.cssText}};const n=(e,...t)=>{const s=1===e.length?e[0]:t.reduce((t,s,r)=>t+(e=>{if(!0===e._$cssResult$)return e.cssText;if("number"==typeof e)return e;throw Error("Value passed to 'css' function must be a 'css' function result: "+e+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(s)+e[r+1],e[0]);return new i(s,e,o)},l=r?e=>e:e=>e instanceof CSSStyleSheet?(e=>{let t="";for(const s of e.cssRules)t+=s.cssText;return(e=>new i("string"==typeof e?e:e+"",void 0,o))(t)})(e):e,{is:c,defineProperty:d,getOwnPropertyDescriptor:h,getOwnPropertyNames:p,getOwnPropertySymbols:u,getPrototypeOf:f}=Object,g=globalThis,m=g.trustedTypes,v=m?m.emptyScript:"",b=g.reactiveElementPolyfillSupport,y=(e,t)=>e,w={toAttribute(e,t){switch(t){case Boolean:e=e?v:null;break;case Object:case Array:e=null==e?e:JSON.stringify(e)}return e},fromAttribute(e,t){let s=e;switch(t){case Boolean:s=null!==e;break;case Number:s=null===e?null:Number(e);break;case Object:case Array:try{s=JSON.parse(e)}catch(e){s=null}}return s}},$=(e,t)=>!c(e,t),_={attribute:!0,type:String,converter:w,reflect:!1,useDefault:!1,hasChanged:$};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */Symbol.metadata??=Symbol("metadata"),g.litPropertyMetadata??=new WeakMap;let x=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=_){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){const s=Symbol(),r=this.getPropertyDescriptor(e,s,t);void 0!==r&&d(this.prototype,e,r)}}static getPropertyDescriptor(e,t,s){const{get:r,set:o}=h(this.prototype,e)??{get(){return this[t]},set(e){this[t]=e}};return{get:r,set(t){const a=r?.call(this);o?.call(this,t),this.requestUpdate(e,a,s)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??_}static _$Ei(){if(this.hasOwnProperty(y("elementProperties")))return;const e=f(this);e.finalize(),void 0!==e.l&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(y("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(y("properties"))){const e=this.properties,t=[...p(e),...u(e)];for(const s of t)this.createProperty(s,e[s])}const e=this[Symbol.metadata];if(null!==e){const t=litPropertyMetadata.get(e);if(void 0!==t)for(const[e,s]of t)this.elementProperties.set(e,s)}this._$Eh=new Map;for(const[e,t]of this.elementProperties){const s=this._$Eu(e,t);void 0!==s&&this._$Eh.set(s,e)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){const t=[];if(Array.isArray(e)){const s=new Set(e.flat(1/0).reverse());for(const e of s)t.unshift(l(e))}else void 0!==e&&t.push(l(e));return t}static _$Eu(e,t){const s=t.attribute;return!1===s?void 0:"string"==typeof s?s:"string"==typeof e?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),void 0!==this.renderRoot&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){const e=new Map,t=this.constructor.elementProperties;for(const s of t.keys())this.hasOwnProperty(s)&&(e.set(s,this[s]),delete this[s]);e.size>0&&(this._$Ep=e)}createRenderRoot(){const e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return((e,t)=>{if(r)e.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(const r of t){const t=document.createElement("style"),o=s.litNonce;void 0!==o&&t.setAttribute("nonce",o),t.textContent=r.cssText,e.appendChild(t)}})(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,s){this._$AK(e,s)}_$ET(e,t){const s=this.constructor.elementProperties.get(e),r=this.constructor._$Eu(e,s);if(void 0!==r&&!0===s.reflect){const o=(void 0!==s.converter?.toAttribute?s.converter:w).toAttribute(t,s.type);this._$Em=e,null==o?this.removeAttribute(r):this.setAttribute(r,o),this._$Em=null}}_$AK(e,t){const s=this.constructor,r=s._$Eh.get(e);if(void 0!==r&&this._$Em!==r){const e=s.getPropertyOptions(r),o="function"==typeof e.converter?{fromAttribute:e.converter}:void 0!==e.converter?.fromAttribute?e.converter:w;this._$Em=r;const a=o.fromAttribute(t,e.type);this[r]=a??this._$Ej?.get(r)??a,this._$Em=null}}requestUpdate(e,t,s,r=!1,o){if(void 0!==e){const a=this.constructor;if(!1===r&&(o=this[e]),s??=a.getPropertyOptions(e),!((s.hasChanged??$)(o,t)||s.useDefault&&s.reflect&&o===this._$Ej?.get(e)&&!this.hasAttribute(a._$Eu(e,s))))return;this.C(e,t,s)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(e,t,{useDefault:s,reflect:r,wrapped:o},a){s&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,a??t??this[e]),!0!==o||void 0!==a)||(this._$AL.has(e)||(this.hasUpdated||s||(t=void 0),this._$AL.set(e,t)),!0===r&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(e){Promise.reject(e)}const e=this.scheduleUpdate();return null!=e&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[e,t]of this._$Ep)this[e]=t;this._$Ep=void 0}const e=this.constructor.elementProperties;if(e.size>0)for(const[t,s]of e){const{wrapped:e}=s,r=this[t];!0!==e||this._$AL.has(t)||void 0===r||this.C(t,void 0,s,r)}}let e=!1;const t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(e=>e.hostUpdate?.()),this.update(t)):this._$EM()}catch(t){throw e=!1,this._$EM(),t}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(e=>this._$ET(e,this[e])),this._$EM()}updated(e){}firstUpdated(e){}};x.elementStyles=[],x.shadowRootOptions={mode:"open"},x[y("elementProperties")]=new Map,x[y("finalized")]=new Map,b?.({ReactiveElement:x}),(g.reactiveElementVersions??=[]).push("2.1.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const k=globalThis,S=e=>e,A=k.trustedTypes,P=A?A.createPolicy("lit-html",{createHTML:e=>e}):void 0,E="$lit$",C=`lit$${Math.random().toFixed(9).slice(2)}$`,T="?"+C,H=`<${T}>`,M=document,D=()=>M.createComment(""),U=e=>null===e||"object"!=typeof e&&"function"!=typeof e,j=Array.isArray,O="[ \t\n\f\r]",z=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,R=/-->/g,N=/>/g,B=RegExp(`>|${O}(?:([^\\s"'>=/]+)(${O}*=${O}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,"g"),L=/'/g,F=/"/g,I=/^(?:script|style|textarea|title)$/i,W=(e=>(t,...s)=>({_$litType$:e,strings:t,values:s}))(1),q=Symbol.for("lit-noChange"),V=Symbol.for("lit-nothing"),Y=new WeakMap,J=M.createTreeWalker(M,129);function G(e,t){if(!j(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return void 0!==P?P.createHTML(t):t}const K=(e,t)=>{const s=e.length-1,r=[];let o,a=2===t?"<svg>":3===t?"<math>":"",i=z;for(let t=0;t<s;t++){const s=e[t];let n,l,c=-1,d=0;for(;d<s.length&&(i.lastIndex=d,l=i.exec(s),null!==l);)d=i.lastIndex,i===z?"!--"===l[1]?i=R:void 0!==l[1]?i=N:void 0!==l[2]?(I.test(l[2])&&(o=RegExp("</"+l[2],"g")),i=B):void 0!==l[3]&&(i=B):i===B?">"===l[0]?(i=o??z,c=-1):void 0===l[1]?c=-2:(c=i.lastIndex-l[2].length,n=l[1],i=void 0===l[3]?B:'"'===l[3]?F:L):i===F||i===L?i=B:i===R||i===N?i=z:(i=B,o=void 0);const h=i===B&&e[t+1].startsWith("/>")?" ":"";a+=i===z?s+H:c>=0?(r.push(n),s.slice(0,c)+E+s.slice(c)+C+h):s+C+(-2===c?t:h)}return[G(e,a+(e[s]||"<?>")+(2===t?"</svg>":3===t?"</math>":"")),r]};class Z{constructor({strings:e,_$litType$:t},s){let r;this.parts=[];let o=0,a=0;const i=e.length-1,n=this.parts,[l,c]=K(e,t);if(this.el=Z.createElement(l,s),J.currentNode=this.el.content,2===t||3===t){const e=this.el.content.firstChild;e.replaceWith(...e.childNodes)}for(;null!==(r=J.nextNode())&&n.length<i;){if(1===r.nodeType){if(r.hasAttributes())for(const e of r.getAttributeNames())if(e.endsWith(E)){const t=c[a++],s=r.getAttribute(e).split(C),i=/([.?@])?(.*)/.exec(t);n.push({type:1,index:o,name:i[2],strings:s,ctor:"."===i[1]?se:"?"===i[1]?re:"@"===i[1]?oe:te}),r.removeAttribute(e)}else e.startsWith(C)&&(n.push({type:6,index:o}),r.removeAttribute(e));if(I.test(r.tagName)){const e=r.textContent.split(C),t=e.length-1;if(t>0){r.textContent=A?A.emptyScript:"";for(let s=0;s<t;s++)r.append(e[s],D()),J.nextNode(),n.push({type:2,index:++o});r.append(e[t],D())}}}else if(8===r.nodeType)if(r.data===T)n.push({type:2,index:o});else{let e=-1;for(;-1!==(e=r.data.indexOf(C,e+1));)n.push({type:7,index:o}),e+=C.length-1}o++}}static createElement(e,t){const s=M.createElement("template");return s.innerHTML=e,s}}function Q(e,t,s=e,r){if(t===q)return t;let o=void 0!==r?s._$Co?.[r]:s._$Cl;const a=U(t)?void 0:t._$litDirective$;return o?.constructor!==a&&(o?._$AO?.(!1),void 0===a?o=void 0:(o=new a(e),o._$AT(e,s,r)),void 0!==r?(s._$Co??=[])[r]=o:s._$Cl=o),void 0!==o&&(t=Q(e,o._$AS(e,t.values),o,r)),t}class X{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){const{el:{content:t},parts:s}=this._$AD,r=(e?.creationScope??M).importNode(t,!0);J.currentNode=r;let o=J.nextNode(),a=0,i=0,n=s[0];for(;void 0!==n;){if(a===n.index){let t;2===n.type?t=new ee(o,o.nextSibling,this,e):1===n.type?t=new n.ctor(o,n.name,n.strings,this,e):6===n.type&&(t=new ae(o,this,e)),this._$AV.push(t),n=s[++i]}a!==n?.index&&(o=J.nextNode(),a++)}return J.currentNode=M,r}p(e){let t=0;for(const s of this._$AV)void 0!==s&&(void 0!==s.strings?(s._$AI(e,s,t),t+=s.strings.length-2):s._$AI(e[t])),t++}}class ee{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,s,r){this.type=2,this._$AH=V,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=s,this.options=r,this._$Cv=r?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode;const t=this._$AM;return void 0!==t&&11===e?.nodeType&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=Q(this,e,t),U(e)?e===V||null==e||""===e?(this._$AH!==V&&this._$AR(),this._$AH=V):e!==this._$AH&&e!==q&&this._(e):void 0!==e._$litType$?this.$(e):void 0!==e.nodeType?this.T(e):(e=>j(e)||"function"==typeof e?.[Symbol.iterator])(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==V&&U(this._$AH)?this._$AA.nextSibling.data=e:this.T(M.createTextNode(e)),this._$AH=e}$(e){const{values:t,_$litType$:s}=e,r="number"==typeof s?this._$AC(e):(void 0===s.el&&(s.el=Z.createElement(G(s.h,s.h[0]),this.options)),s);if(this._$AH?._$AD===r)this._$AH.p(t);else{const e=new X(r,this),s=e.u(this.options);e.p(t),this.T(s),this._$AH=e}}_$AC(e){let t=Y.get(e.strings);return void 0===t&&Y.set(e.strings,t=new Z(e)),t}k(e){j(this._$AH)||(this._$AH=[],this._$AR());const t=this._$AH;let s,r=0;for(const o of e)r===t.length?t.push(s=new ee(this.O(D()),this.O(D()),this,this.options)):s=t[r],s._$AI(o),r++;r<t.length&&(this._$AR(s&&s._$AB.nextSibling,r),t.length=r)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){const t=S(e).nextSibling;S(e).remove(),e=t}}setConnected(e){void 0===this._$AM&&(this._$Cv=e,this._$AP?.(e))}}class te{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,s,r,o){this.type=1,this._$AH=V,this._$AN=void 0,this.element=e,this.name=t,this._$AM=r,this.options=o,s.length>2||""!==s[0]||""!==s[1]?(this._$AH=Array(s.length-1).fill(new String),this.strings=s):this._$AH=V}_$AI(e,t=this,s,r){const o=this.strings;let a=!1;if(void 0===o)e=Q(this,e,t,0),a=!U(e)||e!==this._$AH&&e!==q,a&&(this._$AH=e);else{const r=e;let i,n;for(e=o[0],i=0;i<o.length-1;i++)n=Q(this,r[s+i],t,i),n===q&&(n=this._$AH[i]),a||=!U(n)||n!==this._$AH[i],n===V?e=V:e!==V&&(e+=(n??"")+o[i+1]),this._$AH[i]=n}a&&!r&&this.j(e)}j(e){e===V?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}}class se extends te{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===V?void 0:e}}class re extends te{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==V)}}class oe extends te{constructor(e,t,s,r,o){super(e,t,s,r,o),this.type=5}_$AI(e,t=this){if((e=Q(this,e,t,0)??V)===q)return;const s=this._$AH,r=e===V&&s!==V||e.capture!==s.capture||e.once!==s.once||e.passive!==s.passive,o=e!==V&&(s===V||r);r&&this.element.removeEventListener(this.name,this,s),o&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){"function"==typeof this._$AH?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}}class ae{constructor(e,t,s){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=s}get _$AU(){return this._$AM._$AU}_$AI(e){Q(this,e)}}const ie=k.litHtmlPolyfillSupport;ie?.(Z,ee),(k.litHtmlVersions??=[]).push("3.3.3");const ne=globalThis;
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */class le extends x{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){const t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=((e,t,s)=>{const r=s?.renderBefore??t;let o=r._$litPart$;if(void 0===o){const e=s?.renderBefore??null;r._$litPart$=o=new ee(t.insertBefore(D(),e),e,void 0,s??{})}return o._$AI(e),o})(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return q}}le._$litElement$=!0,le.finalized=!0,ne.litElementHydrateSupport?.({LitElement:le});const ce=ne.litElementPolyfillSupport;ce?.({LitElement:le}),(ne.litElementVersions??=[]).push("4.2.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const de={attribute:!0,type:String,converter:w,reflect:!1,hasChanged:$},he=(e=de,t,s)=>{const{kind:r,metadata:o}=s;let a=globalThis.litPropertyMetadata.get(o);if(void 0===a&&globalThis.litPropertyMetadata.set(o,a=new Map),"setter"===r&&((e=Object.create(e)).wrapped=!0),a.set(s.name,e),"accessor"===r){const{name:r}=s;return{set(s){const o=t.get.call(this);t.set.call(this,s),this.requestUpdate(r,o,e,!0,s)},init(t){return void 0!==t&&this.C(r,void 0,e,t),t}}}if("setter"===r){const{name:r}=s;return function(s){const o=this[r];t.call(this,s),this.requestUpdate(r,o,e,!0,s)}}throw Error("Unsupported decorator location: "+r)};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function pe(e){return(t,s)=>"object"==typeof s?he(e,t,s):((e,t,s)=>{const r=t.hasOwnProperty(s);return t.constructor.createProperty(s,e),r?Object.getOwnPropertyDescriptor(t,s):void 0})(e,t,s)}
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function ue(e){return pe({...e,state:!0,attribute:!1})}const fe=new Map,ge=[1e3,2e3,4e3,8e3,16e3,3e4];function me(e,t={}){const s=t.wsCtor??("undefined"!=typeof WebSocket?WebSocket:void 0),r=t.fetchImpl??("undefined"!=typeof fetch?fetch:void 0);let o=null,a="idle",i=null,n=0,l=null,c=null,d=!1,h=!1;const p=new Set,u=()=>{for(const e of p)try{e(o)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}},f=e=>{a!==e&&(a=e,u())},g=()=>{null!=l&&(clearTimeout(l),l=null)},m=()=>{null!=c&&(clearTimeout(c),c=null)},v=()=>{if(g(),i){i.onopen=null,i.onmessage=null,i.onerror=null,i.onclose=null;try{i.close()}catch{}i=null}},b=()=>{if(d||!s)return;let t;g(),f("idle"===a?"connecting":"reconnecting");try{t=new s(function(e){let t=e.trim().replace(/\/$/,"");return/^https?:\/\//i.test(t)?t=t.replace(/^http/i,"ws"):/^wss?:\/\//i.test(t)||(t=`ws://${t}`),`${t}/ws`}(e))}catch{return void y()}i=t,t.onopen=()=>{d||i!==t||(n=0,f("open"),(()=>{if(h||!r)return;h=!0;const t=function(e,t){let s=e.trim().replace(/\/$/,"");return/^wss?:\/\//i.test(s)?s=s.replace(/^ws/i,"http"):/^https?:\/\//i.test(s)||(s=`http://${s}`),`${s}${t.startsWith("/")?t:`/${t}`}`}(e,"/api/snapshot");r(t).then(e=>e.ok?e.json():null).then(e=>{!d&&e&&null==o&&(o=e,u())}).catch(()=>{})})())},t.onmessage=e=>{if(!d&&i===t)try{const t=JSON.parse("string"==typeof e.data?e.data:"");t&&"snapshot"===t.type&&t.data&&(o=t.data,u())}catch{}},t.onerror=()=>{},t.onclose=()=>{i===t&&(i=null,d?f("closed"):y())}},y=()=>{if(d)return;f("reconnecting");const e=Math.min(n,ge.length-1);n+=1,l=setTimeout(()=>{l=null,b()},ge[e])},w={getSnapshot:()=>o,connectionState:()=>a,subscribe(t){m(),p.add(t);try{t(o)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}return 1===p.size&&null==i&&"open"!==a&&"connecting"!==a&&"reconnecting"!==a&&b(),()=>{p.delete(t)&&0===p.size&&(m(),c=setTimeout(()=>{c=null,0===p.size&&(v(),n=0,h=!1,f("idle"),fe.get(e)===w&&fe.delete(e))},5e3))}},_destroy(){d=!0,m(),v(),f("closed"),p.clear(),fe.get(e)===w&&fe.delete(e)}};return w}class ve extends le{constructor(){super(...arguments),this.snapshot=null,this.connState="idle",this._unsubscribe=null,this._stateTimer=null}setConfig(e){if(!e)throw new Error("Invalid config");this.config={host:e.host||"http://homeassistant.local:8787",title:e.title||"Power",refresh_seconds:e.refresh_seconds??30,type:e.type}}effectiveHost(){return this.config?.host||"http://homeassistant.local:8787"}connectedCallback(){super.connectedCallback();const e=function(e){const t=fe.get(e);if(t)return t;const s=me(e);return fe.set(e,s),s}(this.effectiveHost());this.connState=e.connectionState(),this._unsubscribe=e.subscribe(t=>{this.snapshot=t,this.connState=e.connectionState()})}disconnectedCallback(){super.disconnectedCallback(),this._unsubscribe&&this._unsubscribe(),this._unsubscribe=null,this._stateTimer&&(clearInterval(this._stateTimer),this._stateTimer=null)}getCardSize(){return 6}}t([pe({attribute:!1})],ve.prototype,"config",void 0),t([ue()],ve.prototype,"snapshot",void 0),t([ue()],ve.prototype,"connState",void 0);const be=n`
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
`,ye={};function we(e,t){for(const s of e.split("|"))ye[s.trim()]=t}function $e(e){const t=function(e){const t=function(e){return e.split("·")[0].split("(")[0].replace(/\s+/g," ").trim().toLowerCase()}(e);return t?ye[t]:void 0}(e);return t?W`<span class="ef-glossary"
    >${e}<span class="ef-tooltip" role="tooltip">${t}</span></span
  >`:e}function _e(e,t,s,r){const o=t-e||1,a=r-s;return t=>s+(t-e)/o*a}function xe(e,t={}){const s=t.width??320,r=t.height??40,o=t.color??"var(--ef-accent)",a=e.map(e=>e.value).filter(e=>null!=e&&Number.isFinite(e));if(a.length<2)return W`<div style="height:${r}px;color:var(--ef-muted);font-size:10px;">collecting…</div>`;const i=Math.min(...a),n=Math.max(...a),l=.05*(n-i)||1,c=t.yMin??i-l,d=t.yMax??n+l,h=function(e,t,s){const r=[];let o=!1;for(const a of e){if(null==a.value||!Number.isFinite(a.value)){o=!1;continue}const e=t(a.ts),i=s(a.value);r.push(`${o?"L":"M"} ${e.toFixed(1)} ${i.toFixed(1)}`),o=!0}return r.join(" ")}(e,_e(e[0].ts,e[e.length-1].ts,2,s-2),_e(c,d,r-2,2));return W`
    <svg viewBox="0 0 ${s} ${r}" width="100%" height="${r}" preserveAspectRatio="none" aria-hidden="true">
      <path d=${h} fill="none" stroke=${o} stroke-width="1.5" />
    </svg>
  `}we("soc|state of charge","State of charge — how full the battery is right now, 0–100%."),we("avg soc","Average state of charge across every online battery pack in the fleet."),we("soh|state of health|avg soh","State of health — measured usable capacity vs the pack’s original design capacity. A wear gauge; 100% = like-new."),we("ocv|open-circuit","Open-circuit voltage — the pack’s resting voltage with no load applied."),we("cell spread|worst cell spread|cell imbalance|cell spread now","Cell-voltage spread — the gap between the highest and lowest cell in a pack. A widening gap is an early sign of imbalance."),we("cell mean","Average voltage across all of the pack’s cells."),we("pack volt","Pack terminal voltage."),we("rep temp","Representative pack temperature reported by the BMS."),we("cell max|cell min","Hottest / coldest individual cell temperature in the pack."),we("cell temperatures","Per-cell temperature sensors inside the pack."),we("cell voltages","Per-cell voltage, each shown with its deviation from the pack mean."),we("mos max|mosfet temperatures|mosfet temps|mosfet","Power-MOSFET temperature — the BMS switching transistors."),we("board","BMS circuit-board temperature."),we("shunt","Current-shunt temperature — the precision resistor the BMS measures pack current across."),we("ptc heater temperatures|ptc heater temps|ptc","PTC heater temperature — keeps the cells warm enough to charge safely in the cold."),we("cycles","Equivalent full charge/discharge cycles the pack has completed — a measure of battery age."),we("lifetime throughput","Total energy ever charged into and discharged out of the pack."),we("capacity","Energy the battery can store, in kWh."),we("balancing|cells balancing","The BMS is equalizing cell voltages — routine housekeeping, no action needed."),we("hottest pack","The warmest pack across the fleet right now."),we("vitals","The pack’s key live readings at a glance."),we("pv|pv in|pv total|photovoltaic","Photovoltaic — solar-panel power."),we("pv high mppt|pv low mppt","Power from one of the DPU’s two solar strings (high- or low-voltage MPPT input)."),we("ac out|ac output","AC power flowing out of the inverter to your loads."),we("ac in","AC power flowing into the inverter — grid or generator charging."),we("ac out freq / v","Inverter AC output frequency (Hz) and voltage."),we("total in / out","Total power into and out of the DPU across every input and output."),we("battery v / a","Internal battery-bus voltage and current."),we("in|out","Power flowing in to / out of the device."),we("input|output","Power flowing into (charging) or out of (discharging) the pack."),we("panel load","Total power the SHP2’s circuits are drawing right now."),we("live contribution|live draw","Power this device is feeding/drawing right now."),we("voltage|current","Live electrical voltage / current at this input."),we("v × a","Voltage × current — instantaneous power, shown as a cross-check on the reported watts."),we("string ω","Effective resistance (volts ÷ amps) at the MPPT string’s operating point."),we("mppt|mppt temp|mppt hv|mppt lv|hv mppt|lv mppt","MPPT — the solar charge controller (Maximum Power Point Tracker). Each DPU has two: a high-voltage and a low-voltage string input."),we("hv channels|lv channels","High-/low-voltage MPPT solar string inputs — one of each per DPU."),we("ghi","Global Horizontal Irradiance — total sunlight energy on a flat surface (W/m²); the raw “how sunny” number the forecast is built from."),we("producing now","Solar power being generated right now."),we("peak today","The highest solar power reached so far today."),we("coefficient|peak response|response coefficient","Learned response coefficient — watts of PV produced per W/m² of sunlight. Captures panel size, orientation, shading and inverter clipping."),we("strongest hour","The hour of day your arrays convert sunlight to power most efficiently — reveals their orientation."),we("observed peak pv","The highest PV output actually recorded at this hour-of-day."),we("soiling","Dust/pollen on the panels cutting output. Detected by comparing clear-sky production to the cleanest day on record."),we("output drop","How far clear-sky solar output has fallen below the clean-panel baseline — the soiling indicator."),we("backup|backup pool","SHP2 backup pool — the combined battery the Smart Home Panel draws on."),we("backup %","Backup-pool state of charge, trended over the last hour."),we("reserve floor|backup reserve|reserve","Reserve floor — the state of charge held back for backup. Loads begin shedding below it."),we("solar reserve","Target state of charge to keep in reserve specifically when running on solar."),we("mid-priority floor","The SoC at which mid-priority circuits are cut to protect the battery."),we("charge power","Power currently flowing into the battery."),we("charge time","Estimated time to fully charge the battery."),we("rated power","The device’s rated maximum power output."),we("ems bat temp","Battery temperature as reported by the SHP2’s energy-management system."),we("hw link","Hardware (wired) link status between the SHP2 and this DPU."),we("load-shed strategy","The SHP2’s automatic plan for dropping circuits as the battery depletes."),we("smart backup mode","The SHP2’s backup-behaviour mode setting."),we("charge schedule","The SHP2’s time-of-use scheduled charging windows."),we("error code|direct errors|shp2 errors","Device-reported error code — 0 means no fault."),we("charging power","Power the EV charger is drawing, over the last 24 hours."),we("sessions today","Charging sessions detected today — a sustained draw above 1 kW."),we("host dpu|dpu battery","The Delta Pro Ultra the EV charger is wired to — that DPU’s AC output equals the charging draw."),we("direct telemetry","Raw data straight from the device over MQTT, rather than inferred."),we("solar next 24 h|solar next 24h","Projected solar production, from the cloud forecast run through your learned array model."),we("forecast load|forecast load 24 h|typical solar / day","Projected household load from the typical-day consumption curve."),we("forecast pv","Projected PV output for this hour."),we("projected low soc","The lowest the battery is forecast to reach over the next 24 hours."),we("cloud cover","Forecast cloud cover — what derates the solar prediction each hour."),we("outlook","At-a-glance battery comfort vs the reserve floor: Comfortable, Watch or Tight."),we("history depth","Days of recorded data behind the forecast and learned models — they sharpen as it grows."),we("confidence","How trustworthy the learned model is, based on how many samples it has."),we("z-score|peer z-score","Modified z-score — how many robust deviations a reading sits from normal. Higher = more anomalous; ≥ 3.5 flags, ≥ 5 warns."),we("fit quality|fit r²","R-squared — how well the trend line fits the data, 0–1. Higher means a more trustworthy projection."),we("samples|regression samples","How many data points the estimate is built from — more points, more reliable."),we("sibling median","The median reading across the pack’s four siblings — the “normal” this pack is compared against."),we("this pack","This pack’s current reading."),we("deviation","How far this reading sits from the expected/normal value."),we("baseline window","The span of history and number of samples behind the self-baseline."),we("decline rate|rise rate","How fast the value is changing, per unit time."),we("end-of-life|eol|projected eol|reaches 80%","End of life — the 80%-SoH point where a pack has lost a fifth of its original capacity; the conventional LFP replacement mark."),we("fade rate|fade / yr|avg fade rate","How fast measured capacity (State of Health) is falling — SoH percentage points lost per year."),we("service left|years left|years to eol","Projected years of service remaining before the pack reaches the 80% end-of-life threshold."),we("eol threshold","The State of Health at which a pack counts as end-of-life — conventionally 80% for LFP cells."),we("packs projecting","How many packs have a firm enough SoH trend to project an end-of-life date."),we("soonest eol","The pack across the fleet projected to reach end-of-life first."),we("cycles at eol","Projected equivalent full-cycle count by the time the pack reaches end-of-life."),we("data span","Days of recorded history the projection is regressed over."),we("projection notes","Plain-language end-of-life verdict for each pack with a firm fade trend."),we("trend","Whether a pack has a projected fade trend, is stable, is still learning, or has no data yet."),we("critical","Critical — an immediate problem that needs attention now."),we("warnings|warning","Warning — something to investigate soon."),we("informational|info","Informational — noted for awareness, not urgent."),we("anomalies","Things unusual right now — flagged by peer comparison and self-baseline."),we("forecasts","Where things are heading — runtime, degradation and day-ahead projections."),we("actionable","Critical + warning items that may need attention."),we("recently cleared","Alerts that were raised and have since resolved, with how long each lasted."),we("today","Energy totals since local midnight."),we("solar produced","Total solar energy harvested today."),we("batteries","Net battery energy today — negative means net charged, positive means net discharged.");const ke=(e,t=0)=>null==e?"—":`${e.toFixed(t)}%`,Se=e=>9*e/5+32;class Ae extends le{constructor(){super(...arguments),this.tone="neutral"}render(){return W`<slot></slot>`}}Ae.styles=[be,n`
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
    `],t([pe({reflect:!0})],Ae.prototype,"tone",void 0),customElements.get("ef-badge")||customElements.define("ef-badge",Ae);class Pe extends le{constructor(){super(...arguments),this.label="",this.value="",this.unit=""}render(){return W`
      <div class="label"><slot name="label">${this.label}</slot></div>
      <div class="value-line">
        <span class="value"><slot name="value">${this.value}</slot></span>
        ${this.unit?W`<span class="unit">${this.unit}</span>`:null}
      </div>
      <slot></slot>
    `}}Pe.styles=[be,n`
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
    `],t([pe()],Pe.prototype,"label",void 0),t([pe()],Pe.prototype,"value",void 0),t([pe()],Pe.prototype,"unit",void 0),customElements.get("ef-tile")||customElements.define("ef-tile",Pe);class Ee extends le{constructor(){super(...arguments),this.title=""}render(){return W`
      <header>
        <div class="title"><slot name="title">${this.title}</slot></div>
        <div class="header-extra"><slot name="header"></slot></div>
      </header>
      <div class="body"><slot></slot></div>
    `}}Ee.styles=[be,n`
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
    `],t([pe()],Ee.prototype,"title",void 0),customElements.get("ef-section")||customElements.define("ef-section",Ee);e.EcoflowBatteryCard=class extends ve{constructor(){super(...arguments),this.deg={data:null,stale:!1},this.rte={data:null,stale:!1},this._httpTimer=null}connectedCallback(){super.connectedCallback(),this._kickHttpFetches();const e=Math.max(10,this.config?.refresh_seconds??30);this._httpTimer=setInterval(()=>this._kickHttpFetches(),1e3*e)}disconnectedCallback(){super.disconnectedCallback(),this._httpTimer&&(clearInterval(this._httpTimer),this._httpTimer=null)}_kickHttpFetches(){this._fetchOne("/api/degradation",()=>this.deg,e=>this.deg=e),this._fetchOne("/api/round-trip-efficiency",()=>this.rte,e=>this.rte=e)}async _fetchOne(e,t,s){try{const t=this.effectiveHost().replace(/\/$/,"")+e,r=await fetch(t);if(!r.ok)throw new Error(`HTTP ${r.status}`);s({data:await r.json(),stale:!1})}catch{s({...t(),stale:!0})}}connTone(e){return"open"===e?"ok":"connecting"===e||"reconnecting"===e?"warn":"closed"===e?"bad":"neutral"}connLabel(e){return"open"===e?"live":"connecting"===e?"linking":"reconnecting"===e?"reconnecting":"closed"===e?"offline":"idle"}packTone(e){const t=e.maxCellTemp??e.temp,s=e.maxVolDiffMv,r=e.actSoh??e.soh;let o="ok";const a=e=>{const t={neutral:0,ok:1,warn:2,bad:3};t[e]>t[o]&&(o=e)};if(null!=t){const e=Se(t);e>=113?a("bad"):e>=95&&a("warn")}return null!=s&&(s>100?a("bad"):s>50&&a("warn")),null!=r&&(r<70?a("bad"):r<80&&a("warn")),o}badgeTone(e){return e}tempClass(e){if(null==e)return"";const t=Se(e);return t>=113?"bad":t>=95?"warn":""}spreadClass(e){return null==e?"":e>100?"bad":e>50?"warn":""}sohClass(e){return null==e?"":e<70?"bad":e<80?"warn":""}synthSohTrend(e){if(null==e.currentSoh)return[];const t=(e.fadePctPerYear??0)/365,s=Date.now(),r=[];for(let o=90;o>=0;o--){const a=s-864e5*o,i=e.currentSoh+o*t;r.push({ts:a,value:i})}return r}render(){const e=this.snapshot,t=this.config?.title??"Battery";if(!e)return W`<ha-card>
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
      </ha-card>`;const s=Object.values(e.devices).filter(e=>e.productName.toLowerCase().includes("delta pro ultra"));return W`<ha-card>
      ${this.renderHeader(t,s)}
      ${this.renderFleetRollup(s)}
      ${this.renderPerPackThermal(s)}
      ${this.renderDegradation(s)}
      ${this.renderRoundTripEfficiency()}
    </ha-card>`}renderHeader(e,t){const s=t.reduce((e,t)=>e+(t.projection?.packs.length??0),0);return W`<div class="header">
      <div>
        <div class="title">${e}</div>
        <div class="subtitle">${t.length} DPU · ${s} packs</div>
      </div>
      <div class="badges">
        <ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge>
      </div>
    </div>`}renderFleetRollup(e){let t=0,s=0,r=0,o=0;for(const a of e)if(a.online&&a.projection)for(const e of a.projection.packs){t++,null!=e.soc&&(s+=e.soc);const a=e.actSoh??e.soh;null!=a&&(r+=a),null!=e.fullCapMah&&(o+=e.fullCapMah)}const a=t?s/t:null,i=t?r/t:null,n=.1024*o/1e3,l=null!=a&&n>0?a/100*n:null;return W`<ef-section .title=${"Fleet"}>
      <div class="rollup-row">
        <ef-tile
          label="Stored"
          value=${null!=l?l.toFixed(1):"—"}
          unit=${null!=l?"kWh":""}
        ></ef-tile>
        <ef-tile label="Avg SoC" value=${null!=a?a.toFixed(0):"—"} unit=${null!=a?"%":""}>
          <span slot="label">${$e("avg soc")}</span>
        </ef-tile>
        <ef-tile label="Avg SoH" value=${null!=i?i.toFixed(1):"—"} unit=${null!=i?"%":""}>
          <span slot="label">${$e("avg soh")}</span>
        </ef-tile>
        <ef-tile
          label="Capacity"
          value=${n>0?n.toFixed(1):"—"}
          unit=${n>0?"kWh":""}
        ></ef-tile>
      </div>
    </ef-section>`}renderPerPackThermal(e){return 0===e.length?W`<ef-section .title=${"Per-pack thermal & vitals"}>
        <div class="no-data">No DPU batteries discovered.</div>
      </ef-section>`:W`<ef-section .title=${"Per-pack thermal & vitals"}>
      <div class="pack-grid">${e.map(e=>this.renderDpuBox(e))}</div>
    </ef-section>`}renderDpuBox(e){const t=e.projection,s=t?.packs??[];return W`<div class="dpu-box">
      <div class="dpu-head">
        <div class="dpu-name" title=${e.deviceName}>${e.deviceName}</div>
        <ef-badge tone=${e.online?"ok":"bad"}>${e.online?"online":"offline"}</ef-badge>
      </div>
      ${0===s.length?W`<div class="no-data">
            <ef-badge tone="neutral">no data</ef-badge>
          </div>`:s.map(e=>this.renderPackRow(e))}
    </div>`}renderPackRow(e){const t=this.packTone(e),s=e.maxCellTemp??e.temp,r=e.maxVolDiffMv,o=e.actSoh??e.soh,a=e.soc,i=this.tempClass(s),n=this.spreadClass(r),l=this.sohClass(o);return W`<div class="pack-row" data-tone=${t}>
      <span class="pack-label">Pack ${e.num}</span>
      <span class="pack-vitals">
        <span class="vital ${i}"><span class="k">T</span>${(e=>null==e?"—":`${Math.round(Se(e))}°F`)(s)}</span>
        <span class="vital ${n}"
          ><span class="k">${$e("cell spread")}</span>${null!=r?`${Math.round(r)} mV`:"—"}</span
        >
        <span class="vital"><span class="k">${$e("soc")}</span>${ke(a,0)}</span>
        <span class="vital ${l}"><span class="k">${$e("soh")}</span>${ke(o,1)}</span>
      </span>
      ${"warn"===t||"bad"===t?W`<ef-badge tone=${this.badgeTone(t)}>${"bad"===t?"!":"·"}</ef-badge>`:W`<span></span>`}
    </div>`}renderDegradation(e){const t=this.deg.data,s=this.deg.stale;if(!t&&!s)return W`<ef-section .title=${"Degradation trend"}>
        <div class="no-data">Computing degradation projection…</div>
      </ef-section>`;if(!t)return W`<ef-section .title=${"Degradation trend"}>
        <ef-badge slot="header" tone="warn">stale data</ef-badge>
        <div class="no-data">Degradation projection unavailable.</div>
      </ef-section>`;const r=t.packs;if(0===r.length)return W`<ef-section .title=${"Degradation trend"}>
        ${s?W`<ef-badge slot="header" tone="warn">stale data</ef-badge>`:V}
        <div class="no-data">No battery packs reporting SoH yet.</div>
      </ef-section>`;const o=t.eolSoh,a=r.filter(e=>null!=e.currentSoh&&e.currentSoh<o+5),i=r.filter(e=>e.peerOutlier),n=r.filter(e=>"projecting"===e.status),l=n.reduce((e,t)=>null==e||(t.yearsToEol??1e9)<(e.yearsToEol??1e9)?t:e,null),c=l&&l.eolDate?new Date(l.eolDate).getFullYear():null,d=[...r].sort((e,t)=>(e.currentSoh??999)-(t.currentSoh??999)),h=d.slice(0,6),p=d.length-h.length,u=a.length>0?W`<ef-badge slot="header" tone="warn">${a.length} flagged</ef-badge>`:V;return W`<ef-section .title=${"Degradation trend"}>
      ${u}${s?W`<ef-badge slot="header" tone="warn">stale data</ef-badge>`:V}
      <div class="deg-list">
        ${h.map(e=>this.renderDegRow(e,o))}
      </div>
      <div class="deg-summary full">
        ${p>0?W`<span>+${p} more pack${1===p?"":"s"}.</span> `:V}
        ${a.length>0?W`<span class="flag"
              >${a.map(e=>`${this.packShortLabel(e)} (${e.currentSoh.toFixed(1)}%)`).join(", ")}
              near ${$e("eol")} floor (${o}%).</span
            > `:V}
        ${i.length>0?W`<span class="flag"
              >${i.map(e=>this.packShortLabel(e)).join(", ")} fading faster than peers.</span
            > `:V}
        ${l&&null!=c?W`<span
              >Projected ${$e("eol")}: ${c}
              (${this.packShortLabel(l)}, ~${l.yearsToEol?.toFixed(1)} yr).</span
            >`:0===n.length?W`<span>Not enough history to project end-of-life yet.</span>`:V}
      </div>
    </ef-section>`}packShortLabel(e){return null!=e.coreNum?`Core ${e.coreNum} · Pack ${e.packNum}`:`${e.device} P${e.packNum}`}renderDegRow(e,t){const s=null==e.currentSoh?"neutral":e.currentSoh<t?"bad":e.currentSoh<t+5?"warn":"ok",r=this.synthSohTrend(e),o=null!=e.fadePctPerYear?`${e.fadePctPerYear.toFixed(1)} %/yr fade`:"learning"===e.status?"still learning":"no-data"===e.status?"no data":"stable",a="bad"===s?"var(--ef-bad)":"warn"===s?"var(--ef-warn)":"var(--ef-accent)";return W`<div class="deg-row" data-tone=${s}>
      <div class="label">
        ${this.packShortLabel(e)}
        <span class="sub">${o}</span>
      </div>
      <div class="full">${xe(r,{width:200,height:32,color:a})}</div>
      <div class="soh-val">
        ${null!=e.currentSoh?`${e.currentSoh.toFixed(1)}%`:"—"}
        ${null!=e.yearsToEol?W`<span class="sub">~${e.yearsToEol.toFixed(1)} yr</span>`:V}
      </div>
    </div>`}renderRoundTripEfficiency(){const e=this.rte.data,t=this.rte.stale;if(!e&&!t)return W`<ef-section .title=${"Round-trip efficiency"}>
        <div class="no-data">Computing round-trip efficiency…</div>
      </ef-section>`;if(!e)return W`<ef-section .title=${"Round-trip efficiency"}>
        <ef-badge slot="header" tone="warn">stale data</ef-badge>
        <div class="no-data">${$e("rte")} unavailable.</div>
      </ef-section>`;const s=e.efficiencyPct,r=null==s?"big":s<80?"big bad":s<88?"big warn":"big",o=e.daysWithData>0?`${e.daysWithData}/${e.windowDays}-day rolling window`:"gathering data — needs charge/discharge cycles",a=e.perDay.filter(e=>null!=e.efficiencyPct).map(e=>({ts:new Date(e.date).getTime(),value:e.efficiencyPct}));return W`<ef-section .title=${"Round-trip efficiency"}>
      ${t?W`<ef-badge slot="header" tone="warn">stale data</ef-badge>`:V}
      <div class="rte-row">
        <div class="rte-headline">
          <div class=${r}>${null!=s?`${s.toFixed(1)}%`:"—"}</div>
          <div class="sub">${$e("rte")}: ${o}</div>
          <div class="sub">Industry avg: 88–92%</div>
        </div>
        <div>
          ${a.length>=2?xe(a,{width:200,height:40,color:"var(--ef-accent)",yMin:70,yMax:100}):W`<div class="no-data">Not enough cycle data yet.</div>`}
        </div>
      </div>
    </ef-section>`}},e.EcoflowBatteryCard.styles=[be,n`
      :host {
        display: block;
      }
      ha-card {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .title {
        font-size: 1.1rem;
        font-weight: 600;
        color: var(--ef-ink);
      }
      .subtitle {
        font-size: 0.75rem;
        color: var(--ef-muted);
        margin-top: 2px;
      }
      .badges {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .skeleton {
        padding: 20px;
        text-align: center;
        color: var(--ef-muted);
        font-size: 0.85rem;
      }
      .skeleton .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--ef-accent);
        margin-right: 6px;
        animation: ef-pulse 1.2s ease-in-out infinite;
      }
      @keyframes ef-pulse {
        0%,
        100% {
          opacity: 0.3;
        }
        50% {
          opacity: 1;
        }
      }
      .rollup-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 8px;
        width: 100%;
      }
      /* Per-pack grid: one subsection per DPU, packs stacked as rows. */
      .pack-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 8px;
        width: 100%;
      }
      .dpu-box {
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        background: color-mix(in srgb, var(--ef-panel) 96%, transparent);
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .dpu-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin-bottom: 2px;
      }
      .dpu-name {
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--ef-ink);
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pack-row {
        display: grid;
        grid-template-columns: 56px 1fr auto;
        align-items: center;
        gap: 6px;
        padding: 4px 6px;
        border-radius: 6px;
        font-size: 0.78rem;
        line-height: 1.2;
        min-height: 24px;
      }
      .pack-row[data-tone='warn'] {
        background: color-mix(in srgb, var(--ef-warn) 10%, transparent);
      }
      .pack-row[data-tone='bad'] {
        background: color-mix(in srgb, var(--ef-bad) 12%, transparent);
      }
      .pack-row[data-tone='neutral'] {
        opacity: 0.7;
      }
      .pack-label {
        color: var(--ef-muted);
        font-weight: 500;
      }
      .pack-vitals {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 10px;
        font-variant-numeric: tabular-nums;
        color: var(--ef-ink);
      }
      .pack-vitals .vital {
        white-space: nowrap;
      }
      .pack-vitals .vital .k {
        color: var(--ef-muted);
        font-size: 0.68rem;
        margin-right: 2px;
      }
      .vital.warn {
        color: var(--ef-warn);
        font-weight: 600;
      }
      .vital.bad {
        color: var(--ef-bad);
        font-weight: 600;
      }
      /* Degradation: per-pack row with sparkline */
      .deg-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 100%;
      }
      .deg-row {
        display: grid;
        grid-template-columns: 140px 1fr auto;
        align-items: center;
        gap: 10px;
        padding: 4px 6px;
        border-radius: 6px;
        font-size: 0.78rem;
      }
      .deg-row[data-tone='warn'] {
        background: color-mix(in srgb, var(--ef-warn) 8%, transparent);
      }
      .deg-row[data-tone='bad'] {
        background: color-mix(in srgb, var(--ef-bad) 10%, transparent);
      }
      .deg-row .label {
        font-weight: 500;
        color: var(--ef-ink);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .deg-row .label .sub {
        display: block;
        font-size: 0.65rem;
        color: var(--ef-muted);
        font-weight: 400;
      }
      .deg-row .soh-val {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        text-align: right;
      }
      .deg-row .soh-val .sub {
        display: block;
        font-size: 0.65rem;
        color: var(--ef-muted);
        font-weight: 400;
      }
      .deg-summary {
        font-size: 0.78rem;
        color: var(--ef-muted);
        margin-top: 6px;
        line-height: 1.4;
      }
      .deg-summary .flag {
        color: var(--ef-warn);
        font-weight: 500;
      }
      .rte-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        width: 100%;
        align-items: center;
      }
      .rte-headline {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.85rem;
        color: var(--ef-ink);
      }
      .rte-headline .big {
        font-size: 1.8rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        line-height: 1;
      }
      .rte-headline .big.warn {
        color: var(--ef-warn);
      }
      .rte-headline .big.bad {
        color: var(--ef-bad);
      }
      .rte-headline .sub {
        font-size: 0.7rem;
        color: var(--ef-muted);
      }
      .no-data {
        font-size: 0.78rem;
        color: var(--ef-muted);
        padding: 6px 0;
      }
      .full {
        width: 100%;
      }
    `],t([ue()],e.EcoflowBatteryCard.prototype,"deg",void 0),t([ue()],e.EcoflowBatteryCard.prototype,"rte",void 0),e.EcoflowBatteryCard=t([(e=>(t,s)=>{void 0!==s?s.addInitializer(()=>{customElements.define(e,t)}):customElements.define(e,t)})("ecoflow-battery-card")],e.EcoflowBatteryCard);const Ce=window;return Ce.customCards=Ce.customCards||[],Ce.customCards.some(e=>"ecoflow-battery-card"===e.type)||Ce.customCards.push({type:"ecoflow-battery-card",name:"EcoFlow Battery Card",description:"Fleet thermal + degradation + round-trip efficiency for EcoFlow batteries"}),e}({});
//# sourceMappingURL=ecoflow-battery-card.js.map
