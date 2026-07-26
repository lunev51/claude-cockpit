'use strict';
// Корень ресурсов приложения.
//
// Решение: пакуем с asar:false (electron-builder build.asar=false). Тогда в
// упакованном виде всё дерево проекта лежит распакованным в
// <resources>/app/, и относительные пути renderer (../../node_modules/*),
// спавны vendor/*.exe и python venv работают так же, как в dev — без правок
// renderer и без распаковки asar.
//
// vendor/ и models/ заигнорены в .gitignore, поэтому electron-builder не
// кладёт их в build.files. Они приезжают через build.extraResources в
// <resources>/app/vendor и <resources>/app/models — то есть в тот же appRoot,
// и существующие пути (root + 'vendor'/'models'/'sidecar') их находят.

const path = require('path');
const { app } = require('electron');

// dev: каталог с package.json (app.getAppPath()).
// packaged (asar:false): <process.resourcesPath>/app — туда electron-builder
// раскладывает и build.files, и extraResources(to:'app/...').
function appRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app');
  }
  return app.getAppPath();
}

module.exports = { appRoot };
