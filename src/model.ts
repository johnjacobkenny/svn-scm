import {
  workspace,
  Uri,
  window,
  Disposable,
  WorkspaceFoldersChangeEvent,
  EventEmitter,
  Event,
  commands
} from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as micromatch from "micromatch";
import { Repository, RepositoryState } from "./repository";
import { Svn, Status } from "./svn";
import {
  dispose,
  anyEvent,
  filterEvent,
  IDisposable,
  isDescendant
} from "./util";
import { sequentialize, debounce } from "./decorators";
import { configuration } from "./helpers/configuration";

export interface ModelChangeEvent {
  repository: Repository;
  uri: Uri;
}

export interface OriginalResourceChangeEvent {
  repository: Repository;
  uri: Uri;
}

interface OpenRepository extends Disposable {
  repository: Repository;
}

export class Model implements IDisposable {
  private _onDidOpenRepository = new EventEmitter<Repository>();
  readonly onDidOpenRepository: Event<Repository> = this._onDidOpenRepository
    .event;

  private _onDidCloseRepository = new EventEmitter<Repository>();
  readonly onDidCloseRepository: Event<Repository> = this._onDidCloseRepository
    .event;

  private _onDidChangeRepository = new EventEmitter<ModelChangeEvent>();
  readonly onDidChangeRepository: Event<ModelChangeEvent> = this
    ._onDidChangeRepository.event;

  public openRepositories: OpenRepository[] = [];
  private disposables: Disposable[] = [];
  private enabled = false;
  private possibleSvnRepositoryPaths = new Set<string>();
  private ignoreList: string[] = [];
  private maxDepth: number = 0;

  private configurationChangeDisposable: Disposable;

  get repositories(): Repository[] {
    return this.openRepositories.map(r => r.repository);
  }

  constructor(private svn: Svn) {
    this.enabled = configuration.get<boolean>("enabled") === true;

    this.configurationChangeDisposable = workspace.onDidChangeConfiguration(
      this.onDidChangeConfiguration,
      this
    );

    if (this.enabled) {
      this.enable();
    }
  }

  private onDidChangeConfiguration(): void {
    const enabled = configuration.get<boolean>("enabled") === true;

    this.maxDepth = configuration.get<number>("multipleFolders.depth", 0);

    if (enabled === this.enabled) {
      return;
    }

    this.enabled = enabled;

    if (enabled) {
      this.enable();
    } else {
      this.disable();
    }
  }

  private enable(): void {
    const multipleFolders = configuration.get<boolean>(
      "multipleFolders.enabled",
      false
    );

    if (multipleFolders) {
      this.maxDepth = configuration.get<number>("multipleFolders.depth", 0);

      this.ignoreList = configuration.get("multipleFolders.ignore", []);
    }

    workspace.onDidChangeWorkspaceFolders(
      this.onDidChangeWorkspaceFolders,
      this,
      this.disposables
    );
    this.onDidChangeWorkspaceFolders({
      added: workspace.workspaceFolders || [],
      removed: []
    });

    const fsWatcher = workspace.createFileSystemWatcher("**");
    this.disposables.push(fsWatcher);

    const onWorkspaceChange = anyEvent(
      fsWatcher.onDidChange,
      fsWatcher.onDidCreate,
      fsWatcher.onDidDelete
    );
    const onPossibleSvnRepositoryChange = filterEvent(
      onWorkspaceChange,
      uri => !this.getRepository(uri)
    );
    onPossibleSvnRepositoryChange(
      this.onPossibleSvnRepositoryChange,
      this,
      this.disposables
    );

    window.onDidChangeActiveTextEditor(
      () => this.checkHasChangesOnActiveEditor(),
      this,
      this.disposables
    );

    this.scanWorkspaceFolders();
  }

  private onPossibleSvnRepositoryChange(uri: Uri): void {
    const possibleSvnRepositoryPath = uri.fsPath.replace(/\.svn.*$/, "");
    this.eventuallyScanPossibleSvnRepository(possibleSvnRepositoryPath);
  }

  private eventuallyScanPossibleSvnRepository(path: string) {
    this.possibleSvnRepositoryPaths.add(path);
    this.eventuallyScanPossibleSvnRepositories();
  }

  @debounce(500)
  private eventuallyScanPossibleSvnRepositories(): void {
    for (const path of this.possibleSvnRepositoryPaths) {
      this.tryOpenRepository(path);
    }

    this.possibleSvnRepositoryPaths.clear();
  }

  private scanExternals(repository: Repository): void {
    const shouldScanExternals =
      configuration.get<boolean>("detectExternals") === true;

    if (!shouldScanExternals) {
      return;
    }

    repository.statusExternal
      .map(r => path.join(repository.workspaceRoot, r.path))
      .forEach(p => this.eventuallyScanPossibleSvnRepository(p));
  }

  private hasChangesOnActiveEditor(): boolean {
    if (!window.activeTextEditor) {
      return false;
    }
    const uri = window.activeTextEditor.document.uri;

    const repository = this.getRepository(uri);
    if (!repository) {
      return false;
    }

    const resource = repository.getResourceFromFile(uri);
    if (!resource) {
      return false;
    }

    switch (resource.type) {
      case Status.ADDED:
      case Status.DELETED:
      case Status.EXTERNAL:
      case Status.IGNORED:
      case Status.NONE:
      case Status.NORMAL:
      case Status.UNVERSIONED:
        return false;
      case Status.CONFLICTED:
      case Status.INCOMPLETE:
      case Status.MERGED:
      case Status.MISSING:
      case Status.MODIFIED:
      case Status.OBSTRUCTED:
      case Status.REPLACED:
        return true;
    }

    // Show if not match
    return true;
  }

  @debounce(100)
  private checkHasChangesOnActiveEditor() {
    commands.executeCommand(
      "setContext",
      "svnActiveEditorHasChanges",
      this.hasChangesOnActiveEditor()
    );
  }

  private disable(): void {
    this.repositories.forEach(repository => repository.dispose());
    this.openRepositories = [];

    this.possibleSvnRepositoryPaths.clear();
    this.disposables = dispose(this.disposables);
  }

  private async onDidChangeWorkspaceFolders({
    added,
    removed
  }: WorkspaceFoldersChangeEvent) {
    const possibleRepositoryFolders = added.filter(
      folder => !this.getOpenRepository(folder.uri)
    );

    const openRepositoriesToDispose = removed
      .map(folder => this.getOpenRepository(folder.uri.fsPath))
      .filter(repository => !!repository)
      .filter(
        repository =>
          !(workspace.workspaceFolders || []).some(f =>
            repository!.repository.workspaceRoot.startsWith(f.uri.fsPath)
          )
      ) as OpenRepository[];

    possibleRepositoryFolders.forEach(p =>
      this.tryOpenRepository(p.uri.fsPath)
    );
    openRepositoriesToDispose.forEach(r => r.repository.dispose());
  }

  private async scanWorkspaceFolders() {
    for (const folder of workspace.workspaceFolders || []) {
      const root = folder.uri.fsPath;
      this.tryOpenRepository(root);
    }
  }

  @sequentialize
  async tryOpenRepository(path: string, level = 0): Promise<void> {
    if (this.getRepository(path)) {
      return;
    }

    let isSvnFolder = fs.existsSync(path + "/.svn");

    // If open only a subpath.
    if (!isSvnFolder && level === 0) {
      let pathParts = path.split(/[\\/]/);
      while (pathParts.length > 0) {
        pathParts.pop();
        let topPath = pathParts.join("/") + "/.svn";
        isSvnFolder = fs.existsSync(topPath);
        if (isSvnFolder) {
          break;
        }
      }
    }

    if (isSvnFolder) {
      try {
        const repositoryRoot = await this.svn.getRepositoryRoot(path);

        const repository = new Repository(this.svn.open(repositoryRoot, path));

        this.open(repository);
      } catch (err) {}
      return;
    }

    const newLevel = level + 1;
    if (newLevel <= this.maxDepth) {
      fs.readdirSync(path).forEach(file => {
        const dir = path + "/" + file;

        if (
          fs.statSync(dir).isDirectory() &&
          !micromatch.some([dir], this.ignoreList)
        ) {
          this.tryOpenRepository(dir, newLevel);
        }
      });
    }

    return;
  }

  getRepository(hint: any) {
    const liveRepository = this.getOpenRepository(hint);
    if (liveRepository && liveRepository.repository) {
      return liveRepository.repository;
    }
  }

  getOpenRepository(hint: any): OpenRepository | undefined {
    if (!hint) {
      return undefined;
    }

    if (hint instanceof Repository) {
      return this.openRepositories.find(r => r.repository === hint);
    }

    if (typeof hint === "string") {
      hint = Uri.file(hint);
    }

    if (hint instanceof Uri) {
      return this.openRepositories.find(liveRepository => {
        if (
          !isDescendant(liveRepository.repository.workspaceRoot, hint.fsPath)
        ) {
          return false;
        }

        for (const external of liveRepository.repository.statusExternal) {
          const externalPath = path.join(
            liveRepository.repository.workspaceRoot,
            external.path
          );
          if (isDescendant(externalPath, hint.fsPath)) {
            return false;
          }
        }

        return true;
      });
    }

    for (const liveRepository of this.openRepositories) {
      const repository = liveRepository.repository;

      if (hint === repository.sourceControl) {
        return liveRepository;
      }

      if (hint === repository.changes) {
        return liveRepository;
      }
    }

    return undefined;
  }

  private open(repository: Repository): void {
    const onDidDisappearRepository = filterEvent(
      repository.onDidChangeState,
      state => state === RepositoryState.Disposed
    );
    const disappearListener = onDidDisappearRepository(() => dispose());

    const changeListener = repository.onDidChangeRepository(uri =>
      this._onDidChangeRepository.fire({ repository, uri })
    );

    const statusListener = repository.onDidChangeStatus(() => {
      this.scanExternals(repository);
      this.checkHasChangesOnActiveEditor();
    });
    this.scanExternals(repository);

    const dispose = () => {
      disappearListener.dispose();
      changeListener.dispose();
      statusListener.dispose();
      repository.dispose();

      this.openRepositories = this.openRepositories.filter(
        e => e !== openRepository
      );
      this._onDidCloseRepository.fire(repository);
    };

    const openRepository = { repository, dispose };
    this.openRepositories.push(openRepository);
    this._onDidOpenRepository.fire(repository);
  }

  close(repository: Repository): void {
    const openRepository = this.getOpenRepository(repository);

    if (!openRepository) {
      return;
    }

    openRepository.dispose();
  }

  async pickRepository() {
    if (this.openRepositories.length === 0) {
      throw new Error("There are no available repositories");
    }

    const picks: any[] = this.repositories.map(repository => {
      return {
        label: path.basename(repository.root),
        repository: repository
      };
    });
    const placeHolder = "Choose a repository";
    const pick = await window.showQuickPick(picks, { placeHolder });

    return pick && pick.repository;
  }

  dispose(): void {
    this.disable();
    this.configurationChangeDisposable.dispose();
  }
}
