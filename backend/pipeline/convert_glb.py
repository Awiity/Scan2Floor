import trimesh
import sys

def convert():
    input_file = "data/matterpak/3704a788023947799a970f58f18a9592.obj"
    output_file = "data/matterpak/mesh.glb"
    print(f"Loading {input_file}...")
    
    # Load the mesh, ignoring materials
    mesh = trimesh.load(input_file, process=False, maintain_order=True, force='mesh', skip_materials=True)
    
    # If it loaded a scene, get the geometry
    if isinstance(mesh, trimesh.Scene):
        mesh = trimesh.util.concatenate([geom for geom in mesh.geometry.values()])

    print(f"Loaded mesh with {len(mesh.vertices)} vertices and {len(mesh.faces)} faces.")
    
    # Save to GLB
    mesh.export(output_file, file_type='glb')
    print(f"Saved optimized geometry to {output_file}")

if __name__ == '__main__':
    convert()
