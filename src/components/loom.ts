import Pando         from '@pando'
import Node          from '@components/node'
import Index         from '@components/index'
import Branch        from '@components/branch'
import Snapshot      from '@objects/snapshot'
import Tree          from '@objects/tree'
import File          from '@objects/file'
import BranchFactory from '@factories/branch-factory.ts'
import * as utils    from '@locals/utils'
import path          from 'path'
import CID           from 'cids'
import merge         from 'three-way-merge'

export default class Loom {
  public static paths = {
    root:     '.',
    pando:    '.pando',
    ipfs:     '.pando/ipfs',
    index:    '.pando/index',
    current:  '.pando/current',
    config:   '.pando/config',
    branches: '.pando/branches'
  }
  public pando:    Pando
  public node?:    Node
  public index?:   Index
  public branch =  new BranchFactory(this)
  public paths  =  { ...Loom.paths }

  public get currentBranchName (): string {
    return utils.yaml.read(this.paths.current)
  }

  public set currentBranchName (_name: string) {
    utils.yaml.write(this.paths.current, _name)
  }

  public get currentBranch (): Branch {
    return Branch.load(this, this.currentBranchName)
  }

  public get head () {
    return this.currentBranch.head
  }

  public constructor (_pando: Pando, _path: string = '.', opts?: any) {
    for (let p in this.paths) { this.paths[p] = path.join(_path, this.paths[p]) }
    this.pando = _pando
  }

  public static async new (_pando: Pando, _path: string = '.', opts?: any): Promise < Loom > {
    let loom = new Loom(_pando, _path)

    // Initialize .pando directory
    await utils.fs.mkdir(loom.paths.pando)
    await utils.fs.mkdir(loom.paths.ipfs)
    await utils.fs.mkdir(loom.paths.branches)
    await utils.yaml.write(loom.paths.index, {})
    await utils.yaml.write(loom.paths.config, _pando.configuration)
    // Initialize master branch
    await Branch.new(loom, 'master')
    await utils.yaml.write(loom.paths.current, 'master')

    // Initialize node and index
    loom.node  = await Node.new(loom)
    loom.index = await Index.new(loom)

    return loom
  }

  public static async load (_path: string = '.', opts?: any): Promise < Loom > {
    if (!Loom.exists(_path)) { throw new Error('No pando loom found at ' + _path) }

    let pando  = new Pando(utils.yaml.read(path.join(_path, Loom.paths.config)))
    let loom   = new Loom(pando, _path)
    loom.node  = await Node.load(loom)
    loom.index = await Index.load(loom)

    return loom
  }

  public static exists (_path: string = '.'): boolean {
    for (let p in Loom.paths) {
      let expected = path.join(_path, Loom.paths[p])
      if(!utils.fs.exists(expected)) { return false }
    }
    return true
  }

  public async stage (_paths: string[]): Promise < void > {
    return this.index!.stage(_paths)
  }

  public async snapshot (_message: string): Promise < Snapshot > {
    let index = await this.index!.update()

    if (!this.index!.unsnapshot.length) {
      throw new Error ('Nothing to snapshot')
    }

    let tree    = await this.tree()
    let treeCID = await tree.put(this.node!)
    let parents = this.head !== 'undefined' ? [await this.fromIPLD(await this.node!.get(this.head))] : undefined

    let snapshot = new Snapshot({ author: this.pando.configuration.author, tree: tree, parents: parents, message: _message })
    let cid      = await this.node!.put(await snapshot.toIPLD())

    this.currentBranch.head = cid.toBaseEncodedString()

    return snapshot
  }

  public async checkout (_branchName: string) {
    await this.index!.update()

    if (!Branch.exists(this, _branchName)) {
      throw new Error('Branch ' + _branchName + ' does not exist')
    }
    if (this.index!.unsnapshot.length) {
      throw new Error('You have unsnapshot modifications: ' + this.index!.unsnapshot)
    }
    if (this.index!.modified.length) {
      throw new Error('You have unstaged and unsnaphot modifications: ' + this.index!.modified)
    }

    let newHead  = Branch.head(this, _branchName)
    let baseHead = this.head

    if (newHead !== 'undefined') {
      let baseTree, newTree

      newTree = await this.node!.get(newHead, 'tree')

      if (baseHead !== 'undefined') {
        baseTree = await this.node!.get(baseHead, 'tree')
      } else {
        baseTree = (new Tree({ path: '.', children: [] })).toIPLD()
      }

      await this.updateWorkingDirectory(baseTree, newTree)
      await this.index!.reinitialize(newTree)
    } else {
      await this.index!.reinitialize(await (new Tree({ path: '.', children: [] })).toIPLD())
    }

    this.currentBranchName = _branchName
  }

  public async merge (_destinationBranchName :string)
  {
    await this.index!.update()

    if (!Branch.exists(this, _destinationBranchName)) {
      throw new Error('Branch ' + _destinationBranchName + ' does not exist')
    }
    if (this.index!.unsnapshot.length) {
      throw new Error('You have unsnapshot modifications: ' + this.index!.unsnapshot)
    }
    if (this.index!.modified.length) {
      throw new Error('You have unstaged and unsnaphot modifications: ' + this.index!.modified)
    }

    let destinationHead = Branch.head(this, _destinationBranchName)
    let originHead = this.head
    /*
    * Building snapshot CID array fot the origin branch
    */
    // Get the first snapshot corresponding to the origin Branch
    let originSnapshot = await this.node!.get(originHead)
    // Build a chronological array of all snapshot CIDs
    let originSnapshotCIDs = await this.buildSnapshotCIDS (originSnapshot)

    /*
    * Building snapshot CID array fot the destination branch
    */
    // Get the first snapshot corresponding to the origin Branch
    let destinationSnapshot = await this.node!.get(destinationHead)
    // Build a chronological array of all snapshot CIDs
    let destinationSnapshotCIDs = await this.buildSnapshotCIDS (destinationSnapshot)
    // Get the snapshot corresponding to the

    /*
    * Comparing the origin and destination arrays to get the lowest common ancestor CID
    */
    let lcaCID
    for(let entry of originSnapshotCIDs) {
      if(destinationSnapshotCIDs.indexOf(entry) !== -1) {
        lcaCID = entry
        break
      }
    }

    // Get the three trees. If lcaCID, originHead or destinationHead are 'undefined', then the tree is the default tree (Tree({ path: '.', children: [] })
    let originTree, destinationTree, lcaTree

      originTree = await this.node!.get(originHead, 'tree')
      destinationTree = await this.node!.get(destinationHead, 'tree')
      lcaTree = await this.node!.get(lcaCID,'tree')

      let mergeResult
      mergeResult = await this.mergeTrees(originTree,destinationTree,lcaTree)

      // We analyse the merge report. If it's a conflict...
      if(mergeResult[0] === 'conflict'){
        //... we throw an exception and the conflict report.
        throw new Error('Some of the destination branch files are conflicting with the current one : \n' + mergeResult[1])

      }
      else {
        console.log('Merge successful', mergeResult[0])
        // If there was no conflict, we download the merged Tree, and update the index.
        await this.updateWorkingDirectory(originTree,mergeResult[2])
        await this.index!.reinitialize(mergeResult[2])

        // Create a new Snapshot of the situation.
        await this.snapshot('Merged ' + this.currentBranchName + '  into ' + _destinationBranchName)

        //And we change the working branch to the destination one.
        this.currentBranchName = _destinationBranchName

      }

  }

  public async fromIPLD (object) {
    let attributes = {}, data = {}, node

    switch(object['@type']) {
      case 'snapshot':
        attributes = Reflect.getMetadata('ipld', Snapshot.prototype.constructor);
        break
      case 'tree':
        attributes = Reflect.getMetadata('ipld', Tree.prototype.constructor);
        break
      case 'file':
        attributes = Reflect.getMetadata('ipld', File.prototype.constructor);
        break
      default:
        throw new TypeError('Unrecognized IPLD node.')
    }

    for (let attribute in attributes) {
      if (attributes[attribute].link) {
        let type = attributes[attribute].type

        switch (type) {
          case 'map':
            data['children'] = {}
            for (let child in object) {
              if(child !== '@type' && child !== 'path') {
                data['children'][child] = await this.fromIPLD(await this.node!.get(object[child]['/']))
              }
            }
            break
          case 'array':
            data[attribute] = []
            for (let child of object[attribute]) {
              data[attribute].push(await this.fromIPLD(await this.node!.get(object[attribute][child]['/'])))
            }
            break
          case 'direct':
            data[attribute] = object[attribute]['/']
            break
          default:
            data[attribute] = await this.fromIPLD(await this.node!.get(object[attribute]['/']))
        }
      } else {
        data[attribute] = object[attribute]
      }
    }

    switch(object['@type']) {
      case 'snapshot':
        node = new Snapshot(data)
        break
      case 'tree':
        node = new Tree(data)
        break
      case 'file':
        node = new File(data)
        break
      default:
        throw new TypeError('Unrecognized IPLD node.')
    }

   return node
  }

  private tree () {
    let index  = this.index!.current
    let staged = this.index!.staged
    let tree   = new Tree({ path: '.' })

    for (let file of staged) {
      file.split(path.sep).reduce((parent, name): any => {
        let currentPath = path.join(parent.path!, name)
        if(!parent.children[name]) {
          if(index[currentPath]) {
            parent.children[name] = new File({ path: currentPath, link: index[currentPath].stage })
            index[currentPath].repo = index[currentPath].stage
          } else {
            parent.children[name] = new Tree({ path: currentPath })
          }
        }
        return parent.children[name]
      }, tree)
    }
    this.index!.current = index
    return tree
  }

  private async buildSnapshotCIDS (_snapshot : any) : Promise<Array<any>> {
    let snapshot = _snapshot
    let snapshotCIDs : Array<any> = []

    while(snapshot.parents !== 'undefined'){
      snapshotCIDs.push(snapshot.parents[0])
      snapshot = await this.node!.get(snapshot.parents[0])
    }

    // We add the base root CID
    snapshotCIDs.push('undefined')

    return snapshotCIDs
  }


  /*
  * mergeTrees returns a tuple with :
  * 1 - a merge flag if there is conflict or not.
  * 2- the conflict report (filename : conflict report for every conflicting file)
  * 3- The merged tree if there's no conflict
  */
  private async mergeTrees (_originTree : any, _destinationTree : any , _lcaTree : any) : Promise<[any,any,any]> {
    // Delete meta properties to loop over tree's entries only
    delete _originTree['@type']
    delete _originTree['path']
    // Delete meta properties to loop over tree's entries only
    delete _destinationTree['@type']
    delete _destinationTree['path']

    delete _lcaTree['@type']
    delete _lcaTree['path']

    let mergeResult, mergeTree , mergeFlag, mergeReport

    for(let entry in _destinationTree) {
      if(!_originTree[entry]) {
        // the entry exists in the _destinationTree but not in the base tree : we add the entry to the merge Tree
        mergeTree[entry] = _destinationTree[entry]
        delete _originTree[entry] // @Sarrouy WHY ?
      } else {
        // entry existing both in newTree and in baseTree. We first check the hash equality (basic diff)
        if (_destinationTree[entry]['/'] !== _originTree[entry]['/']) {

          let originEntryType = await this.node!.get(_originTree[entry]['/'], '@type')
          let destinationEntryType  = await this.node!.get(_destinationTree[entry]['/'], '@type')
          if (originEntryType !== destinationEntryType) {
            // entry type differs in baseTree and newTree we add the entry to the merge tree
            mergeTree[entry] = _destinationTree[entry]
          } else if (originEntryType === 'file') {
            // It's time to merged § we go to the _lcaTree and try to find a common file.
            if(!_lcaTree[entry]) {
            //There's no common ancestor : Two way merge
            throw new Error('We can\'t perform a three way merge for ' + entry +'. There\'s no common ancestor in the branch node. Please choose wich file you wan\'t to keep manually')
          } else {
            //There's a common ancestor : three way merge
            let left  = await this.node!.download(_originTree[entry]['/'],{cacheOnly : true})
            let base = await this.node!.download(_lcaTree[entry]['/'],{cacheOnly : true})
            let right = await this.node!.download(_destinationTree[entry]['/'],{cacheOnly : true})

            const merged = merge(left, base, right);

            console.log(merged.conflict);
            console.log(merged.joinedResults())

          }


          } else if (originEntryType === 'tree') {
          // entry is a tree : we call a recursive method to continue building recursively the merge tree.
          let originEntry = await this.node!.get(_originTree[entry]['/'])
          let destinationEntry  = await this.node!.get(_destinationTree[entry]['/'])
          let lcaEntry  = await this.node!.get(_lcaTree[entry]['/'])

          await this.mergeTrees(originEntry, destinationEntry,lcaEntry)          //await this.updateWorkingDirectory(baseEntry, newEntry)
        }

      }
    }

      //Then the _originTree ones (we deleted in _originTree all the common files with _destinationTree to go faster)


    }
    // !!!!! BEWARE OF THE TWO WAY MERGE
    //Find the lowest common tree
      mergeResult[0] = mergeFlag
      mergeResult[1] = mergeReport
      mergeResult[2] = mergeTree


      return mergeResult
  }

  private async updateWorkingDirectory (_baseTree: any, _newTree: any) {
    // Delete meta properties to loop over tree's entries only
    delete _baseTree['@type']
    delete _baseTree['path']
    // Delete meta properties to loop over tree's entries only
    delete _newTree['@type']
    delete _newTree['path']

    for (let entry in _newTree) {
      if (!_baseTree[entry]) {
        // entry existing in newTree but not in baseTree
        await this.node!.download(_newTree[entry]['/'])
        delete _baseTree[entry]
      } else {
        // entry existing both in newTree and in baseTree
        if (_baseTree[entry]['/'] !== _newTree[entry]['/']) {
          let baseEntryType = await this.node!.get(_baseTree[entry]['/'], '@type')
          let newEntryType  = await this.node!.get(_newTree[entry]['/'], '@type')
          if (baseEntryType !== newEntryType) {
            // entry type differs in baseTree and newTree
            await this.node!.download(_newTree[entry]['/'])
          } else if (baseEntryType === 'file') {
            // entry type is the same in baseTree and newTree
            // entry is a file
            await this.node!.download(_newTree[entry]['/'])
          } else if (baseEntryType === 'tree') {
            // entry type is the same in baseTree and newTree
            // entry is a tree
            let baseEntry = await this.node!.get(_baseTree[entry]['/'])
            let newEntry  = await this.node!.get(_newTree[entry]['/'])
            await this.updateWorkingDirectory(baseEntry, newEntry)
          }
        }
        delete _baseTree[entry]
      }
    }

    for (let entry in _baseTree) {
      // Delete remaining files
      let _path = await this.node!.get(_baseTree[entry]['/'], 'path')
      utils.fs.rm(path.join(this.paths.root, _path))
    }
  }
}
