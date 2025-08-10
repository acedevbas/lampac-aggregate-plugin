(function(){
  'use strict';
  // Lampac Aggregate — надстройка к ONLINE: собирает результаты со всех источников
  // Версия надстройки: 0.1.0 (alpha)
  // Работает поверх установленного ONLINE (Lampac) и не требует правки оригинального кода.

  // --- НАСТРОЙКИ ---
  // Если у вас свой Lampac-сервер, положите его базовый URL в Lampa.Storage под ключом 'lampac_localhost'.
  // Пример (в консоли): Lampa.Storage.set('lampac_localhost','https://your-host/');  // Конфиг: единый дефолт и аккуратный геттер
  var DEFAULT_LAMPAC_HOST = 'https://lampa.twoheartsonecloud.ru/';
  function getLampacHost(){
    var h = (Lampa && Lampa.Storage && (Lampa.Storage.get('lampac_localhost')||'')).trim();
    if (!h){
      if (Lampa && Lampa.Storage) Lampa.Storage.set('lampac_localhost', DEFAULT_LAMPAC_HOST);
      return DEFAULT_LAMPAC_HOST;
    }
    // нормализуем хвостовой слэш
    if (h.slice(-1) !== '/') h += '/';
    return h;
  }
  var AGG_HOST = getLampacHost();

  // --- УТИЛИТЫ ---
  function account(url){
    url = String(url||'');
    var email = Lampa.Storage.get('account_email');
    if (email && url.indexOf('account_email=') === -1) url = Lampa.Utils.addUrlComponent(url,'account_email='+encodeURIComponent(email));
    var uid = Lampa.Storage.get('lampac_unic_id','');
    if (!uid){ uid = Lampa.Utils.uid(8).toLowerCase(); Lampa.Storage.set('lampac_unic_id', uid); }
    if (uid && url.indexOf('uid=') === -1) url = Lampa.Utils.addUrlComponent(url,'uid='+encodeURIComponent(uid));
    if (url.indexOf('token=') === -1) url = Lampa.Utils.addUrlComponent(url,'token='); // совместимость
    return url;
  }
  function requestParams(movie, url, flags){
    var q = [];
    var card_source = movie && (movie.source||'tmdb') || 'tmdb';
    q.push('id='+(movie && movie.id));
    if (movie && movie.imdb_id) q.push('imdb_id='+(movie.imdb_id||''));
    if (movie && movie.kinopoisk_id) q.push('kinopoisk_id='+(movie.kinopoisk_id||''));
    var title = flags && flags.search ? flags.search : (movie ? (movie.title||movie.name)||'' : '');
    var ot = movie ? (movie.original_title||movie.original_name)||'' : '';
    q.push('title='+encodeURIComponent(title));
    q.push('original_title='+encodeURIComponent(ot));
    q.push('serial='+(movie && movie.name ? 1 : 0));
    q.push('original_language='+(movie && movie.original_language||''));
    q.push('year='+(((movie && (movie.release_date||movie.first_air_date))||'0000').slice(0,4)));
    q.push('source='+card_source);
    q.push('rchtype='+(window.rch ? window.rch.type : ''));
    if (Lampa.Storage.get('account_email','')) q.push('cub_id='+Lampa.Utils.hash(Lampa.Storage.get('account_email','')));
    return (url.indexOf('?')>=0?url+'&':url+'?')+q.join('&');
  }
  function parseJsonDate(htmlStr, selector){
    try{
      var html = $('<div>'+htmlStr+'</div>');
      var out = [];
      html.find(selector).each(function(){
        var item = $(this);
        var data = JSON.parse(item.attr('data-json'));
        var season = item.attr('s');
        var episode = item.attr('e');
        var text = item.text();
        if (episode) data.episode = parseInt(episode);
        if (season) data.season = parseInt(season);
        if (text) data.text = text;
        data.active = item.hasClass('active');
        out.push(data);
      });
      return out;
    }catch(e){ return []; }
  }
  function parseToVideos(htmlStr){
    var items = parseJsonDate(htmlStr, '.videos__item') || [];
    var buttons = parseJsonDate(htmlStr, '.videos__button') || [];
    var active = buttons.find(function(v){ return v.active; });
    var vids = items.filter(function(v){ return v.method==='play' || v.method==='call'; });
    if (active) vids.forEach(function(v){ v.voice_name = active.text; });
    return vids;
  }
  function qualityOf(v){
    var q = 0;
    if (v && v.quality && typeof v.quality === 'object'){
      var keys = Object.keys(v.quality||{});
      if (keys.length){
        q = Math.max.apply(null, keys.map(function(k){ return parseInt(k)||(/4k/i.test(k)?2160:0); }));
      }
    } else if (v && v.text){
      var m = String(v.text).match(/(\d{3,4})p|4k/i);
      if (m) q = m[1] ? parseInt(m[1]) : 2160;
    }
    return q;
  }
  function uniqBy(arr, keyFn){
    var seen = Object.create(null);
    return arr.filter(function(x){ var k = keyFn(x); if (seen[k]) return false; seen[k]=1; return true; });
  }

  // --- КОМПОНЕНТ ---
  function ComponentAgg(object){
    var network = new Lampa.Reguest();
    var scroll = new Lampa.Scroll({mask:true, over:true});
    var files  = new Lampa.Explorer(object);
    var filter = new Lampa.Filter(object);

    var sources = {};         // { key: {url,name,show} }
    var keys = [];            // порядок источников

    var lastFocus;

    this.create = function(){ return this.render(); };

    this.render = function(){ return files.render(); };

    this.start = function(){
      if (Lampa.Activity.active().activity !== this.activity) return;
      this.initialize();
      Lampa.Controller.add('content',{
        toggle: ()=>{
          Lampa.Controller.collectionSet(scroll.render(), files.render());
          Lampa.Controller.collectionFocus(lastFocus||false, scroll.render());
        },
        back: this.back.bind(this),
        up: ()=>{ if (Navigator.canmove('up')) Navigator.move('up'); else Lampa.Controller.toggle('head'); },
        down: ()=>Navigator.move('down'),
        right: ()=>{ if (Navigator.canmove('right')) Navigator.move('right'); else filter.show(Lampa.Lang.translate('title_filter'),'filter'); },
        left: ()=>{ if (Navigator.canmove('left')) Navigator.move('left'); else Lampa.Controller.toggle('menu'); },
      });
      Lampa.Controller.toggle('content');
    };

    this.back = function(){ Lampa.Activity.backward(); };

    this.reset = function(){
      network.clear();
      scroll.render().find('.empty').remove();
      scroll.clear();
      scroll.reset();
      scroll.body().append(Lampa.Template.get('lampac_content_loading'));
    };

    this.initialize = function(){
      var _this = this;
      this.reset();
      // загружаем внешние ID, если не заданы
      this.externalids().then(function(){
        return _this.fetchSources();
      }).then(function(){
        _this.aggregateAll();
      }).catch(function(e){ _this.empty(e && e.msg); });
    };

    this.externalids = function(){
      var movie = object.movie||{};
      return new Promise(function(resolve){
        if (movie.imdb_id && movie.kinopoisk_id) return resolve();
        var query = [];
        query.push('id='+movie.id);
        query.push('serial='+(movie.name?1:0));
        if (movie.imdb_id) query.push('imdb_id='+(movie.imdb_id||''));
        if (movie.kinopoisk_id) query.push('kinopoisk_id='+(movie.kinopoisk_id||''));
        var url = AGG_HOST + 'externalids?' + query.join('&');
        network.timeout(10000);
        network.silent(account(url), function(json){
          for (var k in json) movie[k] = json[k];
          resolve();
        }, function(){ resolve(); });
      });
    };

    this.fetchSources = function(){
      var _this = this;
      return new Promise(function(resolve, reject){
        var url = requestParams(object.movie, AGG_HOST + 'lite/events?life=true');
        network.timeout(15000);
        network.silent(account(url), function(json){
          if (json && json.accsdb) return reject(json);
          var startList = function(list){
            sources = {};
            (list||[]).forEach(function(j){
              var name = ((j.balanser || j.name.split(' ')[0] || '')+'').toLowerCase();
              sources[name] = { url: j.url, name: j.name, show: (typeof j.show==='undefined'?true:j.show) };
            });
            keys = Object.keys(sources).filter(function(k){ return sources[k].show; });
            if (!keys.length) return reject({msg:'Нет доступных источников'});
            resolve();
          };
          if (json && json.life){
            // live-режим — подтянем liveevents и возьмём видимые
            var lifeUrl = requestParams(object.movie, AGG_HOST + 'lifeevents?memkey=' + (json.memkey||''));
            var tries = 0;
            (function pull(){
              network.timeout(3000);
              network.silent(account(lifeUrl), function(life){
                tries++;
                var list = (life && life.online || []).filter(function(c){ return c.show; });
                if (list.length || tries>10 || (life && life.ready)) startList(list);
                else setTimeout(pull, 1000);
              }, function(){ tries++; if (tries>10) reject({msg:'lifeevents timeout'}); else setTimeout(pull,1000); });
            })();
          } else {
            startList(json);
          }
        }, function(){ reject({msg:'events error'}); });
      });
    };

    this.aggregateAll = function(){
      var _this = this;
      this.reset();
      var status = new Lampa.Status(keys.length);
      var results = {};
      status.onComplite = function(){
        var all = [];
        keys.forEach(function(k){ (results[k]||[]).forEach(function(v){ all.push(v); }); });
        // пометим источник
        all.forEach(function(v){
          v.balanser_key = v.balanser_key || v.balanser || '';
          v.balanser_name = v.balanser_name || (sources[v.balanser_key]?sources[v.balanser_key].name:'');
        });
        // дедуп: сезон|серия|заголовок|озвучка
        all = uniqBy(all, function(v){
          return [(v.season||0),(v.episode||0),(String(v.title||v.text||'').toLowerCase()),(String(v.voice_name||'').toLowerCase())].join('|');
        });
        // сортировка по качеству ↓, затем сезон/серия ↑
        all.sort(function(a,b){
          var qa = qualityOf(a), qb = qualityOf(b);
          if (qa !== qb) return qb-qa;
          if ((a.season||0)!==(b.season||0)) return (a.season||0)-(b.season||0);
          if ((a.episode||0)!==(b.episode||0)) return (a.episode||0)-(b.episode||0);
          return 0;
        });
        _this.draw(all);
      };

      var CONC = 4, inflight=0, queue=keys.slice(0);
      function pump(){
        while(inflight<CONC && queue.length){
          var k = queue.shift();
          inflight++;
          var url = account(requestParams(object.movie, sources[k].url, {search: object.search}));
          network.native(url, function(text){
            try{
              var vids = parseToVideos(text);
              vids.forEach(function(v){ v.balanser_key = k; v.balanser_name = sources[k].name; v._source_page = url; });
              results[k] = vids;
            }catch(e){ results[k] = []; }
            finally { inflight--; status.append(k, results[k]); pump(); }
          }, function(){ inflight--; results[k]=[]; status.append(k, []); pump(); }, false, {dataType:'text'});
        }
      }
      pump();
    };

    this.draw = function(items){
      var _this = this;
      if (!items || !items.length) return this.empty();
      scroll.clear();
      items.forEach(function(element, index){
        // подготовка подписи
        var info = [];
        if (element.voice_name) info.push(element.voice_name);
        if (element.balanser_name) info.push(element.balanser_name);
        element.info = info.map(function(i){ return '<span>'+i+'</span>'; }).join('<span class="online-prestige-split">●</span>');
        element.time = '';
        element.title = element.title || element.text || (object.movie ? (object.movie.title||object.movie.name) : '');
        element.quality = '';

        // Шаблон из ONLINE (если нет — быстрый фолбэк)
        var tpl = Lampa.Template.get('lampac_prestige_full', element);
        if (!tpl || !tpl.length){
          tpl = $('<div class="online-prestige selector" style="padding:1em;background:rgba(0,0,0,.3);border-radius:.3em;">\
              <div style="display:flex;justify-content:space-between;align-items:center;">\
                <div class="online-prestige__title"></div>\
                <div class="online-prestige__quality"></div>\
              </div>\
              <div class="online-prestige__info" style="margin-top:.5em;"></div>\
            </div>');
          tpl.find('.online-prestige__title').text(element.title);
          tpl.find('.online-prestige__quality').text('');
          tpl.find('.online-prestige__info').html(element.info||'');
        }

        tpl.on('hover:enter', function(){
          // Откроем оригинальный ONLINE на нужном источнике и той же странице
          Lampa.Activity.push({
            url: element._source_page ? element._source_page.replace('rjson=','nojson=') : '',
            title: 'Lampac - '+element.title,
            component: 'lampac',
            movie: object.movie,
            page: 1,
            search: object.search || (object.movie?object.movie.title:''),
            clarification: !!object.clarification,
            balanser: element.balanser_key,
            noinfo: true
          });
        }).on('hover:focus', function(e){
          lastFocus = e.target; scroll.update($(e.target), true);
        });

        scroll.append(tpl);
      });
      Lampa.Controller.enable('content');
    };

    this.empty = function(msg){
      var html = Lampa.Template.get('lampac_does_not_answer',{});
      if (!html || !html.length){
        html = $('<div class="online-empty"><div class="online-empty__title"></div><div class="online-empty__time"></div></div>');
      }
      html.find('.online-empty__title').text(Lampa.Lang.translate('empty_title_two'));
      html.find('.online-empty__time').text(msg || Lampa.Lang.translate('empty_text'));
      scroll.clear(); scroll.append(html); Lampa.Controller.enable('content');
    };

    // Монтирование
    var head = filter.render();
    head.find('.filter--sort span').text('Все источники'); // просто метка
    files.appendFiles(scroll.render());
    files.appendHead(head);
    scroll.minus(files.render().find('.explorer__files-head'));
  }

  // --- Регистрация кнопки на карточке ---
  function addButton(e){
    if (!e || !e.render || !e.movie) return;
    if (e.render.find('.lampac--agg-button').length) return;
    var btn = $(
      '<div class="full-start__button selector view--online lampac--agg-button" data-subtitle="Lampac Aggregate">\
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M3 5h18v2H3V5m0 6h18v2H3v-2m0 6h18v2H3v-2z"/></svg>\
        <span>Агрегатор (все источники)</span>\
      </div>'
    );
    btn.on('hover:enter', function(){
      Lampa.Component.add('lampac_agg', ComponentAgg);
      Lampa.Activity.push({
        url:'', title:'Онлайн (агрегатор)', component:'lampac_agg', movie:e.movie, page:1,
        search: e.movie ? (e.movie.title||e.movie.name) : ''
      });
    });
    e.render.after(btn);
  }

  function mount(){
    // кнопка на экране «полной карточки»
    Lampa.Listener.follow('full', function(ev){
      if (ev.type === 'complite'){
        addButton({ render: ev.object.activity.render().find('.view--torrent'), movie: ev.data.movie });
      }
    });
    try{
      if (Lampa.Activity.active().component === 'full'){
        addButton({ render: Lampa.Activity.active().activity.render().find('.view--torrent'), movie: Lampa.Activity.active().card });
      }
    }catch(e){}
  }

  // Подключаем стили, если их нет (реиспользуем стили ONLINE, но с фолбэком)
  if (!$('.online-prestige').length){
    var css = "<style>.online-prestige{position:relative;border-radius:.3em;background:rgba(0,0,0,.3);display:flex}.online-prestige__body{padding:1.2em;flex-grow:1;position:relative}.online-prestige__info{display:flex;align-items:center}.online-prestige-split{font-size:.8em;margin:0 1em;flex-shrink:0}</style>";
    $('body').append(css);
  }

  // Старт
  if (window.appready) mount();
  else Lampa.Listener.follow('app', function(e){ if (e.type==='ready') mount(); });
})();
