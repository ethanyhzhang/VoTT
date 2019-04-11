import _ from "lodash";
import ProjectService, { IProjectService } from "./projectService";
import MockFactory from "../common/mockFactory";
import { StorageProviderFactory } from "../providers/storage/storageProviderFactory";
import { IProject, IExportFormat, ISecurityToken, AssetState, IAsset } from "../models/applicationState";
import { constants } from "../common/constants";
import { ExportProviderFactory } from "../providers/export/exportProviderFactory";
import { generateKey } from "../common/crypto";
import { encryptProject } from "../common/utils";
import { AssetService } from "./assetService";

describe("Project Service", () => {
    let projectSerivce: IProjectService = null;
    let testProject: IProject = null;
    let projectList: IProject[] = null;
    let securityToken: ISecurityToken = null;

    const storageProviderMock = {
        writeText: jest.fn((project) => Promise.resolve(project)),
        deleteFile: jest.fn(() => Promise.resolve()),
    };

    const exportProviderMock = {
        export: jest.fn(() => Promise.resolve()),
        save: jest.fn((exportFormat: IExportFormat) => Promise.resolve(exportFormat.providerOptions)),
    };

    StorageProviderFactory.create = jest.fn(() => storageProviderMock);
    ExportProviderFactory.create = jest.fn(() => exportProviderMock);
    

    beforeEach(() => {
        securityToken = {
            name: "TestToken",
            key: generateKey(),
        };
        testProject = MockFactory.createTestProject("TestProject");
        projectSerivce = new ProjectService();

        storageProviderMock.writeText.mockClear();
        storageProviderMock.deleteFile.mockClear();
    });

    it("Load decrypts any project settings using the specified key", async () => {
        const encryptedProject = encryptProject(testProject, securityToken);
        const decryptedProject = await projectSerivce.load(encryptedProject, securityToken);

        expect(decryptedProject).toEqual(testProject);
    });

    it("Saves calls project storage provider to write project", async () => {
        const result = await projectSerivce.save(testProject, securityToken);

        const encryptedProject: IProject = {
            ...testProject,
            sourceConnection: { ...testProject.sourceConnection },
            targetConnection: { ...testProject.targetConnection },
            exportFormat: { ...testProject.exportFormat },
        };
        encryptedProject.sourceConnection.providerOptions = {
            encrypted: expect.any(String),
        };
        encryptedProject.targetConnection.providerOptions = {
            encrypted: expect.any(String),
        };
        encryptedProject.exportFormat.providerOptions = {
            encrypted: expect.any(String),
        };

        expect(result).toEqual(encryptedProject);
        expect(StorageProviderFactory.create).toBeCalledWith(
            testProject.targetConnection.providerType,
            testProject.targetConnection.providerOptions,
        );

        expect(storageProviderMock.writeText).toBeCalledWith(
            `${testProject.name}${constants.projectFileExtension}`,
            expect.any(String));
    });

    it("Save calls configured export provider save when defined", async () => {
        testProject.exportFormat = {
            providerType: "azureCustomVision",
            providerOptions: null,
        };

        await projectSerivce.save(testProject, securityToken);

        expect(ExportProviderFactory.create).toBeCalledWith(
            testProject.exportFormat.providerType,
            testProject,
            testProject.exportFormat.providerOptions,
        );
        expect(exportProviderMock.save).toBeCalledWith(testProject.exportFormat);
    });

    it("Save throws error if writing to storage provider fails", async () => {
        const expectedError = "Error writing to storage provider";
        storageProviderMock.writeText.mockImplementationOnce(() => Promise.reject(expectedError));
        await expect(projectSerivce.save(testProject, securityToken)).rejects.toEqual(expectedError);
    });

    it("Save throws error if storage provider cannot be created", async () => {
        const expectedError = new Error("Error creating storage provider");
        const createMock = StorageProviderFactory.create as jest.Mock;
        createMock.mockImplementationOnce(() => { throw expectedError; });

        await expect(projectSerivce.save(testProject, securityToken)).rejects.toEqual(expectedError);
    });

    it("Delete calls project storage provider to delete project", async () => {
        await projectSerivce.delete(testProject);

        expect(StorageProviderFactory.create).toBeCalledWith(
            testProject.targetConnection.providerType,
            testProject.targetConnection.providerOptions,
        );

        expect(storageProviderMock.deleteFile).toBeCalledWith(`${testProject.name}${constants.projectFileExtension}`);
    });

    it("Delete call fails if deleting from storageProvider fails", async () => {
        const expectedError = "Error deleting from storage provider";
        storageProviderMock.deleteFile
            .mockImplementationOnce(() => Promise.reject(expectedError));

        await expect(projectSerivce.delete(testProject)).rejects.toEqual(expectedError);
    });

    it("Delete call fails if storage provider cannot be created", async () => {
        const expectedError = new Error("Error creating storage provider");
        const createMock = StorageProviderFactory.create as jest.Mock;
        createMock.mockImplementationOnce(() => { throw expectedError; });

        await expect(projectSerivce.delete(testProject)).rejects.toEqual(expectedError);
    });

    it("isDuplicate returns false when called with a unique project", async () => {
        testProject = MockFactory.createTestProject("TestProject");
        projectList = MockFactory.createTestProjects();
        expect(projectSerivce.isDuplicate(testProject, projectList)).toEqual(false);
    });

    it("isDuplicate returns true when called with a duplicate project", async () => {
        testProject = MockFactory.createTestProject("1");
        testProject.id = undefined;
        projectList = MockFactory.createTestProjects();
        expect(projectSerivce.isDuplicate(testProject, projectList)).toEqual(true);
    });

    function populateProjectAssets(project?: IProject, assetCount = 10) {
        if (!project) {
            project = MockFactory.createTestProject();
        }
        const assets = MockFactory.createTestAssets(assetCount);
        assets.forEach((asset) => {
            asset.state = AssetState.Tagged;
        });

        project.assets = _.keyBy(assets, (asset) => asset.id);
        return project;
    }

    it("deletes all asset metadata files when project is deleted", async () => {
        const assetCount = 10;
        populateProjectAssets(testProject);

        await projectSerivce.delete(testProject);
        expect(storageProviderMock.deleteFile.mock.calls).toHaveLength(assetCount + 1);
    });

    it("Deletes tag from all assets within project", async () => {
        const tag1 = "tag1";
        const tag2 = "tag2";
        const region = MockFactory.createTestRegion(undefined, [tag1, tag2])
        const asset = MockFactory.createTestAsset();
        AssetService.prototype.getAssetMetadata = jest.fn((asset: IAsset) => Promise.resolve(
            MockFactory.createTestAssetMetadata(
                asset,
                [region]
            )
        ));

        const saveMetadata = jest.fn();
        AssetService.prototype.save = saveMetadata;

        const expectedAssetMetadata = MockFactory.createTestAssetMetadata(
            asset,
            [
                {
                    ...region,
                    tags: [tag2]
                }
            ]
        );
        const project = populateProjectAssets();
        const originalAssets = {...project.assets};
        await projectSerivce.deleteTag(project, tag1);
        expect(saveMetadata).toBeCalledWith(expectedAssetMetadata);
        fail();
    });

    it("Deletes any empty regions after deleting only tag from region", async () => {
        const project = populateProjectAssets();
        const originalAssets = {...project.assets};
        await projectSerivce.deleteTag(project, defaultTag);
        fail();
    });

    it("Updates renamed tag within all assets of project", async () => {
        const tag = "Tag";
        const newTag = "New Tag";
        const project = populateProjectAssets();
        const originalAssets = {...project.assets};
        await projectSerivce.updateTag(project, tag, newTag);
        fail();
    });

});
